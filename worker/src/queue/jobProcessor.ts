import { Job } from "bullmq";
import { logger } from "../index";
import {
  VerificationJobData,
  VerificationResult,
  GateResult,
} from "./jobQueue";
import { runGates } from "../gates/gateRunner";
import { detectLanguage } from "../lib/languageDetector";
import { createFirecrackerVM, destroyFirecrackerVM, VMHandle } from "../vm/firecracker";
import { getVMConfig } from "../vm/vmConfig";
import { withTimeout } from "../lib/timeout";
import { postVerificationResult } from "../convex/client";

/**
 * Main entry-point invoked by the BullMQ worker for every verification job.
 *
 * Lifecycle:
 *  1. Detect the project language (from hint or heuristic).
 *  2. Spin up a Firecracker microVM with the appropriate rootfs image.
 *  3. Clone the repo at the specified commit inside the VM.
 *  4. Run the gate pipeline (build -> lint -> typecheck -> security -> sonarqube -> test).
 *  5. Tear down the VM.
 *  6. Report the results back to Convex.
 */
export async function processVerificationJob(
  job: Job<VerificationJobData, VerificationResult>,
): Promise<VerificationResult> {
  const startTime = Date.now();
  const data = job.data;
  let vm: VMHandle | null = null;

  try {
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

    // 4. Clone repo inside VM
    await vm.exec(
      `git clone --depth 1 ${data.repoUrl} /workspace && ` +
      `cd /workspace && git checkout ${data.commitSha}`,
    );

    await job.updateProgress(25);

    // 5. Run gate pipeline with overall timeout
    const gateResults: GateResult[] = await withTimeout(
      () => runGates(vm!, language, job),
      data.timeoutSeconds * 1_000,
      `Verification timed out after ${data.timeoutSeconds}s`,
    );

    await job.updateProgress(95);

    // 6. Compute overall status
    const overallStatus = computeOverallStatus(gateResults);

    const result: VerificationResult = {
      jobId: data.jobId,
      submissionId: data.submissionId,
      bountyId: data.bountyId,
      overallStatus,
      gates: gateResults,
      totalDurationMs: Date.now() - startTime,
    };

    // 7. Report back to Convex
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
    // 8. Always tear down the VM
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
