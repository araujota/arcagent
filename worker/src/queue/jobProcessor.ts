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
  let vm: VMHandle | null = null;

  try {
    // 0. Validate all shell-interpolated inputs upfront
    const safeRepoUrl = sanitizeShellArg(data.repoUrl, "repoUrl", "repoUrl");
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
    await vm.exec(cloneCmd);
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
    };

    // 8. Report back to Convex
    if (data.convexUrl) {
      await postVerificationResult(data.convexUrl, result).catch((err) => {
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
    };

    // Best-effort reporting
    if (data.convexUrl) {
      await postVerificationResult(data.convexUrl, errorResult).catch(() => {});
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
