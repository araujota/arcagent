import { Job } from "bullmq";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../index";
import {
  VerificationJobData,
  VerificationResult,
  GateResult,
  ValidationReceipt,
} from "./jobQueue";
import { runVerificationLegs } from "../gates/legRunner";
import { detectLanguage } from "../lib/languageDetector";
import { computeDiff } from "../lib/diffComputer";
import { DiffContext } from "../lib/diffContext";
import { sanitizeShellArg, validateShellArg } from "../lib/shellSanitize";
import { createFirecrackerVM, destroyFirecrackerVM, VMHandle } from "../vm/firecracker";
import { getVMConfig } from "../vm/vmConfig";
import { withTimeout } from "../lib/timeout";
import {
  postVerificationArtifact,
  postVerificationReceipt,
  postVerificationResult,
} from "../convex/client";
import { generateFeedback, VerificationFeedback } from "../lib/feedbackFormatter";
import { execFileAsync } from "../lib/execFileAsync";
import { buildAuthenticatedCloneRepoUrl } from "../lib/repoProviderAuth";

function redactToken(value: string, token?: string): string {
  if (!token) return value;
  return value.split(token).join("<redacted>");
}

export async function processVerificationJob(
  job: Job<VerificationJobData, VerificationResult>,
): Promise<VerificationResult> {
  const startTime = Date.now();
  const data = job.data;
  const convexCallbackUrl = data.convexHttpActionsUrl ?? data.convexUrl;
  let vm: VMHandle | null = null;

  try {
    const cloneRepo = buildAuthenticatedCloneRepoUrl(
      data.repoUrl,
      data.repoAuthToken,
      data.repoAuthUsername,
    );
    const safeRepoUrl = sanitizeShellArg(cloneRepo.url, "repoCloneUrl", "repoUrl");
    const safeCommitSha = sanitizeShellArg(data.commitSha, "commitSha", "commitSha");
    if (data.baseCommitSha) {
      validateShellArg(data.baseCommitSha, "commitSha", "baseCommitSha");
    }

    const language = data.language ?? (await detectLanguage(data.repoUrl));
    logger.info("Detected language", { jobId: data.jobId, language });

    await job.updateProgress(5);

    const vmConfig = getVMConfig(language);

    vm = await createFirecrackerVM({
      jobId: data.jobId,
      rootfsImage: vmConfig.rootfsImage,
      vcpuCount: vmConfig.vcpuCount,
      memSizeMib: vmConfig.memSizeMib,
    });
    logger.info("MicroVM started", { jobId: data.jobId, vmId: vm.vmId });

    await job.updateProgress(15);

    const safeBaseCommitSha = data.baseCommitSha
      ? sanitizeShellArg(data.baseCommitSha, "commitSha", "baseCommitSha")
      : null;
    const cloneCmd = safeBaseCommitSha
      ? `git clone ${safeRepoUrl} /workspace && cd /workspace && git checkout ${safeCommitSha}`
      : `git clone --depth 1 ${safeRepoUrl} /workspace && cd /workspace && git checkout ${safeCommitSha}`;

    try {
      await vm.exec(cloneCmd);
    } catch (cloneErr) {
      const rawMessage = cloneErr instanceof Error ? cloneErr.message : String(cloneErr);
      throw new Error(`Failed to clone repo: ${redactToken(rawMessage, cloneRepo.tokenForRedaction).slice(0, 500)}`);
    }
    await vm.exec("chown -R agent:agent /workspace 2>/dev/null || true");

    await job.updateProgress(20);

    let effectiveBaseCommitSha = data.baseCommitSha;
    if (!effectiveBaseCommitSha) {
      try {
        const mergeBaseResult = await vm.exec(
          `cd /workspace && git merge-base origin/HEAD ${safeCommitSha} 2>/dev/null || true`,
          20_000,
        );
        const mergeBase = mergeBaseResult.stdout.trim();
        if (mergeBase) {
          effectiveBaseCommitSha = mergeBase;
        }
      } catch (err) {
        logger.warn("Failed to resolve merge-base for diff-scoped policies", {
          jobId: data.jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let diffContext: DiffContext | null = null;
    if (effectiveBaseCommitSha) {
      diffContext = await computeDiff(vm, effectiveBaseCommitSha, data.commitSha);
      if (diffContext) {
        logger.info("Diff context computed", {
          jobId: data.jobId,
          changedFiles: diffContext.changedFiles.length,
          baseCommitSha: effectiveBaseCommitSha,
        });
      }
    }

    await job.updateProgress(25);

    const attemptNumber = data.attemptNumber ?? 1;

    const legOutput = await withTimeout(
      () => runVerificationLegs({
        vm: vm!,
        language,
        job,
        diff: diffContext,
        testSuites: data.testSuites,
        stepDefinitionsPublic: data.stepDefinitionsPublic,
        stepDefinitionsHidden: data.stepDefinitionsHidden,
        attemptNumber,
        candidateCommitSha: data.commitSha,
        baseCommitSha: effectiveBaseCommitSha,
        onReceipt: async (receipt) => {
          if (!convexCallbackUrl || !data.jobHmac) return;
          await postVerificationReceipt(convexCallbackUrl, receipt, data.jobHmac).catch((err) => {
            logger.error("Failed to post verification receipt", {
              jobId: data.jobId,
              legKey: receipt.legKey,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
      }),
      data.timeoutSeconds * 1_000,
      `Verification timed out after ${data.timeoutSeconds}s`,
    );

    await job.updateProgress(95);

    const overallStatus = computeOverallStatusFromReceipts(legOutput.receipts);

    const feedback: VerificationFeedback = generateFeedback(legOutput.legacyGates, attemptNumber);

    const result: VerificationResult = {
      jobId: data.jobId,
      submissionId: data.submissionId,
      bountyId: data.bountyId,
      overallStatus,
      gates: legOutput.legacyGates,
      totalDurationMs: Date.now() - startTime,
      steps: legOutput.steps.length > 0 ? legOutput.steps : undefined,
      feedbackJson: JSON.stringify(feedback),
      jobHmac: data.jobHmac,
      validationReceipts: legOutput.receipts,
    };

    if (convexCallbackUrl) {
      await postVerificationResult(convexCallbackUrl, result).catch((err) => {
        logger.error("Failed to post result to Convex", {
          jobId: data.jobId,
          error: err,
        });
      });

      if (data.jobHmac) {
        const artifact = await createArtifactBundle({
          verificationId: data.verificationId,
          result,
        });
        await postVerificationArtifact(convexCallbackUrl, {
          verificationId: data.verificationId,
          submissionId: data.submissionId,
          bountyId: data.bountyId,
          jobId: data.jobId,
          attemptNumber,
          filename: artifact.filename,
          contentType: artifact.contentType,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
          manifestJson: artifact.manifestJson,
          bundleBase64: artifact.bundleBase64,
          jobHmac: data.jobHmac,
        }).catch((err) => {
          logger.error("Failed to post verification artifact", {
            jobId: data.jobId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
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
      validationReceipts: [
        makeTopLevelErrorReceipt(data, "verification_runtime_error", error.message, data.attemptNumber ?? 1),
      ],
    };

    if (convexCallbackUrl) {
      await postVerificationResult(convexCallbackUrl, errorResult).catch(() => {});
    }

    throw error;
  } finally {
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

    const cloneRepo = buildAuthenticatedCloneRepoUrl(
      data.repoUrl,
      data.repoAuthToken,
      data.repoAuthUsername,
    );
    const safeRepoUrl = sanitizeShellArg(cloneRepo.url, "repoCloneUrl", "repoUrl");
    const safeCommitSha = sanitizeShellArg(data.commitSha, "commitSha", "commitSha");

    const language = data.language ?? (await detectLanguage(data.repoUrl));
    logger.info("Diff verification: detected language", { jobId: data.jobId, language });

    await job.updateProgress(5);

    const vmConfig = getVMConfig(language);
    vm = await createFirecrackerVM({
      jobId: data.jobId,
      rootfsImage: vmConfig.rootfsImage,
      vcpuCount: vmConfig.vcpuCount,
      memSizeMib: vmConfig.memSizeMib,
    });
    logger.info("Diff verification: microVM started", { jobId: data.jobId, vmId: vm.vmId });

    await job.updateProgress(15);

    const cloneCmd = `git clone ${safeRepoUrl} /workspace && cd /workspace && git checkout ${safeCommitSha}`;
    try {
      await vm.exec(cloneCmd);
    } catch (cloneErr) {
      const rawMessage = cloneErr instanceof Error ? cloneErr.message : String(cloneErr);
      throw new Error(`Failed to clone repo: ${redactToken(rawMessage, cloneRepo.tokenForRedaction).slice(0, 500)}`);
    }
    await vm.exec("chown -R agent:agent /workspace 2>/dev/null || true");

    await job.updateProgress(20);

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
      const receipt = makeTopLevelErrorReceipt(
        data,
        "patch_apply",
        `${patchGate.summary}\n${applyResult.stderr || applyResult.stdout || ""}`,
        data.attemptNumber ?? 1,
      );

      const result: VerificationResult = {
        jobId: data.jobId,
        submissionId: data.submissionId,
        bountyId: data.bountyId,
        overallStatus: "fail",
        gates: [patchGate],
        totalDurationMs: Date.now() - startTime,
        feedbackJson: JSON.stringify(feedback),
        jobHmac: data.jobHmac,
        validationReceipts: [receipt],
      };

      if (convexCallbackUrl) {
        if (data.jobHmac) {
          await postVerificationReceipt(convexCallbackUrl, receipt, data.jobHmac).catch(() => {});
        }
        await postVerificationResult(convexCallbackUrl, result).catch((err) => {
          logger.error("Failed to post patch-apply failure to Convex", { jobId: data.jobId, error: err });
        });
      }

      return result;
    }

    await vm.exec(`rm ${patchPath}`);
    await job.updateProgress(25);

    let diffContext: DiffContext | null = null;
    try {
      diffContext = await computeDiff(vm, data.commitSha, "WORKTREE");
    } catch (err) {
      logger.warn("Failed to compute diff context for diff-based verification", {
        jobId: data.jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await job.updateProgress(30);

    const attemptNumber = data.attemptNumber ?? 1;
    const legOutput = await withTimeout(
      () => runVerificationLegs({
        vm: vm!,
        language,
        job,
        diff: diffContext,
        testSuites: data.testSuites,
        stepDefinitionsPublic: data.stepDefinitionsPublic,
        stepDefinitionsHidden: data.stepDefinitionsHidden,
        attemptNumber,
        candidateCommitSha: data.commitSha,
        baseCommitSha: data.commitSha,
        onReceipt: async (receipt) => {
          if (!convexCallbackUrl || !data.jobHmac) return;
          await postVerificationReceipt(convexCallbackUrl, receipt, data.jobHmac).catch((err) => {
            logger.error("Failed to post diff verification receipt", {
              jobId: data.jobId,
              legKey: receipt.legKey,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
      }),
      data.timeoutSeconds * 1_000,
      `Verification timed out after ${data.timeoutSeconds}s`,
    );

    await job.updateProgress(95);

    const overallStatus = computeOverallStatusFromReceipts(legOutput.receipts);
    const feedback: VerificationFeedback = generateFeedback(legOutput.legacyGates, attemptNumber);

    const result: VerificationResult = {
      jobId: data.jobId,
      submissionId: data.submissionId,
      bountyId: data.bountyId,
      overallStatus,
      gates: legOutput.legacyGates,
      totalDurationMs: Date.now() - startTime,
      steps: legOutput.steps.length > 0 ? legOutput.steps : undefined,
      feedbackJson: JSON.stringify(feedback),
      jobHmac: data.jobHmac,
      validationReceipts: legOutput.receipts,
    };

    if (convexCallbackUrl) {
      await postVerificationResult(convexCallbackUrl, result).catch((err) => {
        logger.error("Failed to post diff verification result to Convex", {
          jobId: data.jobId,
          error: err,
        });
      });

      if (data.jobHmac) {
        const artifact = await createArtifactBundle({
          verificationId: data.verificationId,
          result,
        });
        await postVerificationArtifact(convexCallbackUrl, {
          verificationId: data.verificationId,
          submissionId: data.submissionId,
          bountyId: data.bountyId,
          jobId: data.jobId,
          attemptNumber,
          filename: artifact.filename,
          contentType: artifact.contentType,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
          manifestJson: artifact.manifestJson,
          bundleBase64: artifact.bundleBase64,
          jobHmac: data.jobHmac,
        }).catch((err) => {
          logger.error("Failed to post diff verification artifact", {
            jobId: data.jobId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
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
      validationReceipts: [
        makeTopLevelErrorReceipt(data, "verification_runtime_error", error.message, data.attemptNumber ?? 1),
      ],
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

function computeOverallStatusFromReceipts(
  receipts: ValidationReceipt[],
): "pass" | "fail" | "error" {
  const blocking = receipts.filter((r) => r.blocking);
  if (blocking.some((r) => r.status === "error")) return "error";
  if (blocking.some((r) => r.status === "fail" || r.status === "warning" || r.status === "unreached")) {
    return "fail";
  }
  return "pass";
}

function makeTopLevelErrorReceipt(
  data: VerificationJobData,
  legKey: string,
  rawBody: string,
  attemptNumber: number,
): ValidationReceipt {
  const now = Date.now();
  return {
    verificationId: data.verificationId,
    jobId: data.jobId,
    submissionId: data.submissionId,
    bountyId: data.bountyId,
    attemptNumber,
    legKey,
    orderIndex: 0,
    status: "error",
    blocking: true,
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    summaryLine: "Verification runtime error",
    rawBody,
  };
}

async function createArtifactBundle(args: {
  verificationId?: string;
  result: VerificationResult;
}): Promise<{
  filename: string;
  contentType: string;
  sha256: string;
  bytes: number;
  manifestJson: string;
  bundleBase64: string;
}> {
  const tempRoot = await mkdtemp(join(tmpdir(), "arcagent-verification-artifact-"));
  const bundleRoot = join(tempRoot, "bundle");
  const sarifDir = join(bundleRoot, "sarif");
  const rawDir = join(bundleRoot, "raw");
  const testDir = join(bundleRoot, "test");
  const createdAt = Date.now();

  try {
    await mkdir(sarifDir, { recursive: true });
    await mkdir(rawDir, { recursive: true });
    await mkdir(testDir, { recursive: true });

    const manifest = {
      verificationId: args.verificationId,
      submissionId: args.result.submissionId,
      bountyId: args.result.bountyId,
      jobId: args.result.jobId,
      overallStatus: args.result.overallStatus,
      totalDurationMs: args.result.totalDurationMs,
      createdAt,
      attemptNumber: args.result.validationReceipts?.[0]?.attemptNumber ?? 1,
    };

    const receipts = args.result.validationReceipts ?? [];
    await writeFile(join(bundleRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await writeFile(join(bundleRoot, "receipts.json"), JSON.stringify(receipts, null, 2), "utf8");

    for (const receipt of receipts) {
      if (receipt.sarifJson) {
        await writeFile(join(sarifDir, `${receipt.orderIndex}-${receipt.legKey}.sarif.json`), receipt.sarifJson, "utf8");
      }
      if (receipt.rawBody) {
        await writeFile(join(rawDir, `${receipt.orderIndex}-${receipt.legKey}.log`), receipt.rawBody, "utf8");
      }
    }

    await writeFile(join(testDir, "bdd_steps.json"), JSON.stringify(args.result.steps ?? [], null, 2), "utf8");

    const regressionReceipt = receipts.find((receipt) => receipt.legKey === "regression_no_new_failures");
    await writeFile(
      join(testDir, "regression_delta.json"),
      regressionReceipt?.policyJson ?? JSON.stringify({}),
      "utf8",
    );

    const filename = `verification_${args.verificationId ?? args.result.submissionId}_attempt_${manifest.attemptNumber}_${createdAt}.zip`;
    const zipPath = join(tempRoot, filename);

    try {
      await execFileAsync("zip", ["-r", zipPath, "."], { cwd: bundleRoot });
    } catch {
      // Fallback to JSON blob serialized as .zip payload when zip utility is unavailable.
      const fallback = Buffer.from(JSON.stringify({ manifest, receipts, steps: args.result.steps ?? [] }), "utf8");
      await writeFile(zipPath, fallback);
    }

    const bytes = await readFile(zipPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    return {
      filename,
      contentType: "application/zip",
      sha256,
      bytes: bytes.byteLength,
      manifestJson: JSON.stringify(manifest),
      bundleBase64: bytes.toString("base64"),
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}
