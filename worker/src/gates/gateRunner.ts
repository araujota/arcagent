import { Job } from "bullmq";
import { logger } from "../index";
import { VerificationJobData, GateResult, GateStatus } from "../queue/jobQueue";
import { VMHandle } from "../vm/firecracker";
import { getVMConfig } from "../vm/vmConfig";
import { runBuildGate } from "./buildGate";
import { runLintGate } from "./lintGate";
import { runTypecheckGate } from "./typecheckGate";
import { runSecurityGate } from "./securityGate";
import { runSonarQubeGate } from "./sonarqubeGate";
import { runTestGate } from "./testGate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A gate function receives the VM handle, language, and returns a result. */
export type GateFn = (
  vm: VMHandle,
  language: string,
  timeoutMs: number,
) => Promise<GateResult>;

/** Descriptor for a single gate in the pipeline. */
interface GateDescriptor {
  name: string;
  fn: GateFn;
  /** If true, pipeline stops when this gate fails. Defaults to true. */
  failFast?: boolean;
}

// ---------------------------------------------------------------------------
// Gate pipeline definition
// ---------------------------------------------------------------------------

/**
 * The ordered list of gates.  Gates run sequentially; if a gate with
 * `failFast: true` (the default) returns "fail" or "error" the remaining
 * gates are skipped.
 */
const GATE_PIPELINE: GateDescriptor[] = [
  { name: "build", fn: runBuildGate, failFast: true },
  { name: "lint", fn: runLintGate, failFast: false },
  { name: "typecheck", fn: runTypecheckGate, failFast: true },
  { name: "security", fn: runSecurityGate, failFast: false },
  { name: "sonarqube", fn: runSonarQubeGate, failFast: false },
  { name: "test", fn: runTestGate, failFast: true },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Execute all gates sequentially inside the given VM.
 *
 * Progress is reported back through the BullMQ job so the caller can poll.
 * When a fail-fast gate fails, remaining gates are marked as "skipped".
 */
export async function runGates(
  vm: VMHandle,
  language: string,
  job: Job<VerificationJobData>,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  const vmConfig = getVMConfig(language);
  let pipelineAborted = false;

  // Progress spans from 25 (after repo clone) to 95 (before result posting).
  // Distribute evenly across gates.
  const progressStart = 25;
  const progressEnd = 95;
  const progressPerGate =
    (progressEnd - progressStart) / GATE_PIPELINE.length;

  for (let i = 0; i < GATE_PIPELINE.length; i++) {
    const gate = GATE_PIPELINE[i]!;

    if (pipelineAborted) {
      results.push({
        gate: gate.name,
        status: "skipped",
        durationMs: 0,
        summary: "Skipped due to previous gate failure",
      });
      continue;
    }

    logger.info(`Running gate: ${gate.name}`, {
      jobId: job.data.jobId,
      gate: gate.name,
    });

    try {
      const result = await gate.fn(vm, language, vmConfig.defaultGateTimeoutMs);
      results.push(result);

      logger.info(`Gate completed: ${gate.name}`, {
        jobId: job.data.jobId,
        gate: gate.name,
        status: result.status,
        durationMs: result.durationMs,
      });

      // Check fail-fast
      if (
        gate.failFast !== false &&
        (result.status === "fail" || result.status === "error")
      ) {
        logger.warn(`Fail-fast triggered by gate: ${gate.name}`, {
          jobId: job.data.jobId,
        });
        pipelineAborted = true;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`Gate threw an exception: ${gate.name}`, {
        jobId: job.data.jobId,
        gate: gate.name,
        error: error.message,
      });

      results.push({
        gate: gate.name,
        status: "error",
        durationMs: 0,
        summary: `Unexpected error: ${error.message}`,
      });

      if (gate.failFast !== false) {
        pipelineAborted = true;
      }
    }

    // Update progress
    const progress = Math.round(progressStart + progressPerGate * (i + 1));
    await job.updateProgress(progress);
  }

  return results;
}
