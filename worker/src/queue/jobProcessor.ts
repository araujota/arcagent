import { Job } from "bullmq";
import { logger } from "../index";
import {
  VerificationJobData,
  VerificationResult,
  GateResult,
  StepResult,
} from "./jobQueue";
import { runGates } from "../gates/gateRunner";
import { detectLanguage } from "../lib/languageDetector";
import { computeDiff } from "../lib/diffComputer";
import { DiffContext } from "../lib/diffContext";
import { sanitizeShellArg, validateShellArg } from "../lib/shellSanitize";
import { createFirecrackerVM, destroyFirecrackerVM, VMHandle } from "../vm/firecracker";
import { getVMConfig } from "../vm/vmConfig";
import { withTimeout } from "../lib/timeout";
import { postVerificationResult } from "../convex/client";
import { generateFeedback, VerificationFeedback } from "../lib/feedbackFormatter";

function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const match = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function buildAuthenticatedCloneRepoUrl(
  repoUrl: string,
  repoAuthToken?: string,
): { url: string; tokenForRedaction?: string } {
  if (!repoAuthToken) return { url: repoUrl };

  if (!/^[A-Za-z0-9_-]+$/.test(repoAuthToken)) {
    throw new Error("Invalid repoAuthToken format");
  }

  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) return { url: repoUrl };

  return {
    url: `https://x-access-token:${repoAuthToken}@github.com/${parsed.owner}/${parsed.repo}.git`,
    tokenForRedaction: repoAuthToken,
  };
}

function redactToken(value: string, token?: string): string {
  if (!token) return value;
  return value.split(token).join("<redacted>");
}

/**
 * Main entry-point invoked by the BullMQ worker for every verification job.
 *
 * Lifecycle:
 *  1. Detect the project language (from hint or heuristic).
 *  2. Spin up a Firecracker microVM with the appropriate rootfs image.
 *  3. Clone the repo at the specified commit inside the VM.
 *  4. Compute diff context (if baseCommitSha available).
 *  5. Run the gate pipeline (build -> lint -> typecheck -> security -> memory -> snyk -> sonarqube -> test).
 *  6. Tear down the VM.
 *  7. Report the results back to Convex.
 */
export async function processVerificationJob(
  job: Job<VerificationJobData, VerificationResult>,
): Promise<VerificationResult> {
  const startTime = Date.now();
  const data = job.data;
  const convexCallbackUrl = data.convexHttpActionsUrl ?? data.convexUrl;
  let vm: VMHandle | null = null;

  try {
    // 0. Validate all shell-interpolated inputs upfront
    const cloneRepo = buildAuthenticatedCloneRepoUrl(data.repoUrl, data.repoAuthToken);
    const safeRepoUrl = sanitizeShellArg(cloneRepo.url, "repoCloneUrl", "repoUrl");
    const safeCommitSha = sanitizeShellArg(data.commitSha, "commitSha", "commitSha");
    if (data.baseCommitSha) {
      validateShellArg(data.baseCommitSha, "commitSha", "baseCommitSha");
    }

    // 1. Language detection
    const language = data.language ?? (await detectLanguage(data.repoUrl));
    logger.info("Detected language", { jobId: data.jobId, language });

    await job.updateProgress(5);

    // 2. Determine VM configuration
    const vmConfig = getVMConfig(language);

    // 3. Create Firecracker microVM
    vm = await createFirecrackerVM({
      jobId: data.jobId,
      rootfsImage: vmConfig.rootfsImage,
      vcpuCount: vmConfig.vcpuCount,
      memSizeMib: vmConfig.memSizeMib,
    });
    logger.info("MicroVM started", { jobId: data.jobId, vmId: vm.vmId });

    await job.updateProgress(15);

    // 4. Clone repo inside VM (root phase for setup)
    const safeBaseCommitSha = data.baseCommitSha
      ? sanitizeShellArg(data.baseCommitSha, "commitSha", "baseCommitSha")
      : null;
    const cloneCmd = safeBaseCommitSha
      ? `git clone ${safeRepoUrl} /workspace && cd /workspace && git checkout ${safeCommitSha}`
      : `git clone --depth 1 ${safeRepoUrl} /workspace && cd /workspace && git checkout ${safeCommitSha}`;

    // Root phase: clone and set ownership to unprivileged agent user
    try {
      await vm.exec(cloneCmd);
    } catch (cloneErr) {
      const rawMessage = cloneErr instanceof Error ? cloneErr.message : String(cloneErr);
      throw new Error(`Failed to clone repo: ${redactToken(rawMessage, cloneRepo.tokenForRedaction).slice(0, 500)}`);
    }
    await vm.exec("chown -R agent:agent /workspace 2>/dev/null || true");

    await job.updateProgress(20);

    // 5. Compute diff context (if baseCommitSha available)
    let diffContext: DiffContext | null = null;
    if (data.baseCommitSha) {
      diffContext = await computeDiff(vm, data.baseCommitSha, data.commitSha);
      if (diffContext) {
        logger.info("Diff context computed", {
          jobId: data.jobId,
          changedFiles: diffContext.changedFiles.length,
        });
      }
    }

    await job.updateProgress(25);

    // 6. Run gate pipeline with overall timeout
    const gateResults: GateResult[] = await withTimeout(
      () => runGates(vm!, language, job, diffContext),
      data.timeoutSeconds * 1_000,
      `Verification timed out after ${data.timeoutSeconds}s`,
    );

    await job.updateProgress(95);

    // 7. Compute overall status (ZTACO mode: ANY non-skipped gate failing means fail)
    const overallStatus = data.ztacoMode
      ? computeOverallStatusZtaco(gateResults)
      : computeOverallStatus(gateResults);

    // Collect visibility-tagged steps from gate results (test gate)
    const allSteps: StepResult[] = [];
    for (const gate of gateResults) {
      if (gate.steps) {
        allSteps.push(...gate.steps);
      }
    }

    // Generate structured feedback for iterative improvement
    const attemptNumber = data.attemptNumber ?? 1;
    const feedback: VerificationFeedback = generateFeedback(gateResults, attemptNumber);

    const result: VerificationResult = {
      jobId: data.jobId,
      submissionId: data.submissionId,
      bountyId: data.bountyId,
      overallStatus,
      gates: gateResults,
      totalDurationMs: Date.now() - startTime,
      steps: allSteps.length > 0 ? allSteps : undefined,
      feedbackJson: JSON.stringify(feedback),
      jobHmac: data.jobHmac,
    };

    // 8. Report back to Convex
    if (convexCallbackUrl) {
      await postVerificationResult(convexCallbackUrl, result).catch((err) => {
        logger.error("Failed to post result to Convex", {
          jobId: data.jobId,
          error: err,
        });
      });
    }

    await job.updateProgress(100);

    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error("Verification job failed", {
      jobId: data.jobId,
      error: error.message,
      stack: error.stack,
    });

    const errorResult: VerificationResult = {
      jobId: data.jobId,
      submissionId: data.submissionId,
      bountyId: data.bountyId,
      overallStatus: "error",
      gates: [],
      totalDurationMs: Date.now() - startTime,
      jobHmac: data.jobHmac,
    };

    // Best-effort reporting
    if (convexCallbackUrl) {
      await postVerificationResult(convexCallbackUrl, errorResult).catch(() => {});
    }

    throw error;
  } finally {
    // 9. Always tear down the VM
    if (vm) {
      await destroyFirecrackerVM(vm).catch((cleanupErr) => {
        logger.error("Failed to destroy microVM", {
          jobId: data.jobId,
          vmId: vm!.vmId,
          error: cleanupErr,
        });
      });
    }
  }
}

/**
 * Diff-based verification processor.
 *
 * Instead of cloning a specific commit, this:
 *  1. Clones the base repo at the base commit.
 *  2. Applies the agent's diff patch.
 *  3. Runs the same 8-gate pipeline.
 *
 * If the patch fails to apply, the job fails immediately at a "patch-apply" gate.
 */
export async function processVerificationFromDiff(
  job: Job<VerificationJobData, VerificationResult>,
): Promise<VerificationResult> {
  const startTime = Date.now();
  const data = job.data;
  const convexCallbackUrl = data.convexHttpActionsUrl ?? data.convexUrl;
  let vm: VMHandle | null = null;

  try {
    if (!data.diffPatch) {
      throw new Error("diffPatch is required for diff-based verification");
    }

    // 0. Validate base repo inputs
    const cloneRepo = buildAuthenticatedCloneRepoUrl(data.repoUrl, data.repoAuthToken);
    const safeRepoUrl = sanitizeShellArg(cloneRepo.url, "repoCloneUrl", "repoUrl");
    const safeCommitSha = sanitizeShellArg(data.commitSha, "commitSha", "commitSha");

    // 1. Language detection
    const language = data.language ?? (await detectLanguage(data.repoUrl));
    logger.info("Diff verification: detected language", { jobId: data.jobId, language });

    await job.updateProgress(5);

    // 2. Create CLEAN verification VM
    const vmConfig = getVMConfig(language);
    vm = await createFirecrackerVM({
      jobId: data.jobId,
      rootfsImage: vmConfig.rootfsImage,
      vcpuCount: vmConfig.vcpuCount,
      memSizeMib: vmConfig.memSizeMib,
    });
    logger.info("Diff verification: microVM started", { jobId: data.jobId, vmId: vm.vmId });

    await job.updateProgress(15);

    // 3. Clone original repo at base commit
    const cloneCmd = `git clone ${safeRepoUrl} /workspace && cd /workspace && git checkout ${safeCommitSha}`;
    try {
      await vm.exec(cloneCmd);
    } catch (cloneErr) {
      const rawMessage = cloneErr instanceof Error ? cloneErr.message : String(cloneErr);
      throw new Error(`Failed to clone repo: ${redactToken(rawMessage, cloneRepo.tokenForRedaction).slice(0, 500)}`);
    }
    await vm.exec("chown -R agent:agent /workspace 2>/dev/null || true");

    await job.updateProgress(20);

    // 4. Write diff to temp file and apply
    if (!vm.writeFile) {
      throw new Error("VM does not support writeFile — cannot apply diff patch");
    }
    const patchPath = "/workspace/.arcagent/agent.patch";
    await vm.exec("mkdir -p /workspace/.arcagent && chown -R agent:agent /workspace/.arcagent 2>/dev/null || true");
    await vm.writeFile(patchPath, Buffer.from(data.diffPatch), "0644", "agent:agent");

    const applyResult = await vm.exec(
      `cd /workspace && git apply --whitespace=fix ${patchPath}`,
      30_000,
      "agent",
    );

    if (applyResult.exitCode !== 0) {
      logger.warn("Diff verification patch apply failed", {
        jobId: data.jobId,
        exitCode: applyResult.exitCode,
        stdout: applyResult.stdout?.slice(0, 2000),
        stderr: applyResult.stderr?.slice(0, 2000),
      });

      // Patch failed to apply — fail immediately
      const patchGate: GateResult = {
        gate: "patch-apply",
        status: "fail",
        durationMs: Date.now() - startTime,
        summary: "Failed to apply agent's diff patch to clean repository clone",
        details: {
          stdout: applyResult.stdout?.slice(0, 5000),
          stderr: applyResult.stderr?.slice(0, 5000),
          exitCode: applyResult.exitCode,
        },
      };

      const feedback = generateFeedback([patchGate], data.attemptNumber ?? 1);

      const result: VerificationResult = {
        jobId: data.jobId,
        submissionId: data.submissionId,
        bountyId: data.bountyId,
        overallStatus: "fail",
        gates: [patchGate],
        totalDurationMs: Date.now() - startTime,
        feedbackJson: JSON.stringify(feedback),
        jobHmac: data.jobHmac,
      };

      if (convexCallbackUrl) {
        await postVerificationResult(convexCallbackUrl, result).catch((err) => {
          logger.error("Failed to post patch-apply failure to Convex", { jobId: data.jobId, error: err });
        });
      }

      return result;
    }

    // Clean up the patch file
    await vm.exec(`rm ${patchPath}`);

    await job.updateProgress(25);

    // 5. Compute diff context from the applied patch
    let diffContext: DiffContext | null = null;
    try {
      diffContext = await computeDiff(vm, data.commitSha, "WORKTREE");
    } catch (err) {
      logger.warn("Failed to compute diff context for diff-based verification", {
        jobId: data.jobId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Diff context is optional — proceed without it
    }

    await job.updateProgress(30);

    // 6. Run gate pipeline
    const gateResults: GateResult[] = await withTimeout(
      () => runGates(vm!, language, job, diffContext),
      data.timeoutSeconds * 1_000,
      `Verification timed out after ${data.timeoutSeconds}s`,
    );

    await job.updateProgress(95);

    // 7. Compute overall status
    const overallStatus = data.ztacoMode
      ? computeOverallStatusZtaco(gateResults)
      : computeOverallStatus(gateResults);

    const allSteps: StepResult[] = [];
    for (const gate of gateResults) {
      if (gate.steps) {
        allSteps.push(...gate.steps);
      }
    }

    const attemptNumber = data.attemptNumber ?? 1;
    const feedback: VerificationFeedback = generateFeedback(gateResults, attemptNumber);

    const result: VerificationResult = {
      jobId: data.jobId,
      submissionId: data.submissionId,
      bountyId: data.bountyId,
      overallStatus,
      gates: gateResults,
      totalDurationMs: Date.now() - startTime,
      steps: allSteps.length > 0 ? allSteps : undefined,
      feedbackJson: JSON.stringify(feedback),
      jobHmac: data.jobHmac,
    };

    // 8. Report back to Convex
    if (convexCallbackUrl) {
      await postVerificationResult(convexCallbackUrl, result).catch((err) => {
        logger.error("Failed to post diff verification result to Convex", {
          jobId: data.jobId,
          error: err,
        });
      });
    }

    await job.updateProgress(100);
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error("Diff verification job failed", {
      jobId: data.jobId,
      error: error.message,
      stack: error.stack,
    });

    const errorResult: VerificationResult = {
      jobId: data.jobId,
      submissionId: data.submissionId,
      bountyId: data.bountyId,
      overallStatus: "error",
      gates: [],
      totalDurationMs: Date.now() - startTime,
      jobHmac: data.jobHmac,
    };

    if (convexCallbackUrl) {
      await postVerificationResult(convexCallbackUrl, errorResult).catch(() => {});
    }

    throw error;
  } finally {
    if (vm) {
      await destroyFirecrackerVM(vm).catch((cleanupErr) => {
        logger.error("Failed to destroy diff verification microVM", {
          jobId: data.jobId,
          vmId: vm!.vmId,
          error: cleanupErr,
        });
      });
    }
  }
}

/**
 * Determine the overall verification status from individual gate results.
 * Any "fail" or "error" means the whole verification fails.
 */
function computeOverallStatus(
  gates: GateResult[],
): "pass" | "fail" | "error" {
  if (gates.some((g) => g.status === "error")) return "error";
  if (gates.some((g) => g.status === "fail")) return "fail";
  return "pass";
}

/**
 * ZTACO mode: ANY non-skipped gate failing means overall fail.
 * Advisory gates (lint, typecheck, security, etc.) now block too.
 */
function computeOverallStatusZtaco(
  gates: GateResult[],
): "pass" | "fail" | "error" {
  const nonSkipped = gates.filter((g) => g.status !== "skipped");
  if (nonSkipped.some((g) => g.status === "error")) return "error";
  if (nonSkipped.some((g) => g.status === "fail")) return "fail";
  return "pass";
}
