import { Job } from "bullmq";
import { logger } from "../index";
import { VerificationJobData, GateResult, GateStatus, TestSuiteInput } from "../queue/jobQueue";
import { VMHandle } from "../vm/firecracker";
import { getVMConfig } from "../vm/vmConfig";
import { DiffContext } from "../lib/diffContext";
import { runBuildGate } from "./buildGate";
import { runLintGate } from "./lintGate";
import { runTypecheckGate } from "./typecheckGate";
import { runSecurityGate } from "./securityGate";
import { runMemoryGate } from "./memoryGate";
import { runSnykGate } from "./snykGate";
import { runSonarQubeGate } from "./sonarqubeGate";
import { runTestGate } from "./testGate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A gate function receives the VM handle, language, timeout, and diff context. */
export type GateFn = (
  vm: VMHandle,
  language: string,
  timeoutMs: number,
  diff: DiffContext | null,
) => Promise<GateResult>;

/** Descriptor for a single gate in the pipeline. */
interface GateDescriptor {
  name: string;
  fn: GateFn;
  /** If true, pipeline stops when this gate fails. Defaults to true. */
  failFast?: boolean;
}

function getGateDisableReason(gateName: string, gateSettings: Record<string, unknown>): string | null {
  if (gateName === "snyk" && gateSettings.snykEnabled === false) {
    return "Snyk disabled by bounty creator";
  }
  if (gateName === "sonarqube" && gateSettings.sonarqubeEnabled === false) {
    return "SonarQube disabled by bounty creator";
  }
  return null;
}

function skippedGateResult(gateName: string, summary: string): GateResult {
  return {
    gate: gateName,
    status: "skipped",
    durationMs: 0,
    summary,
  };
}

function shouldAbortAfterResult(args: {
  ztacoMode: boolean;
  gate: GateDescriptor;
  result: GateResult;
}): boolean {
  if (args.ztacoMode || args.gate.failFast === false) {
    return false;
  }
  return args.result.status === "fail" || args.result.status === "error";
}

function shouldAbortAfterException(ztacoMode: boolean, gate: GateDescriptor): boolean {
  return !ztacoMode && gate.failFast !== false;
}

function buildGateExceptionResult(gateName: string, error: Error): GateResult {
  return {
    gate: gateName,
    status: "error",
    durationMs: 0,
    summary: `Unexpected error: ${error.message}`,
  };
}

async function executeGate(args: {
  gate: GateDescriptor;
  vm: VMHandle;
  language: string;
  timeoutMs: number;
  diff: DiffContext | null;
  testSuites?: TestSuiteInput[];
  stepDefinitionsPublic?: string;
  stepDefinitionsHidden?: string;
}): Promise<GateResult> {
  if (args.gate.name === "test") {
    return runTestGate(
      args.vm,
      args.language,
      args.timeoutMs,
      args.diff,
      args.testSuites,
      args.stepDefinitionsPublic,
      args.stepDefinitionsHidden,
    );
  }
  return args.gate.fn(args.vm, args.language, args.timeoutMs, args.diff);
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
  { name: "typecheck", fn: runTypecheckGate, failFast: false },
  { name: "security", fn: runSecurityGate, failFast: false },
  { name: "memory", fn: runMemoryGate, failFast: false },
  { name: "snyk", fn: runSnykGate, failFast: false },
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
  diff: DiffContext | null,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  const vmConfig = getVMConfig(language);
  let pipelineAborted = false;
  const ztacoMode = job.data.ztacoMode ?? false;
  const testSuites: TestSuiteInput[] | undefined = job.data.testSuites;
  const stepDefinitionsPublic: string | undefined = job.data.stepDefinitionsPublic;
  const stepDefinitionsHidden: string | undefined = job.data.stepDefinitionsHidden;

  // Progress spans from 25 (after repo clone) to 95 (before result posting).
  // Distribute evenly across gates.
  const progressStart = 25;
  const progressEnd = 95;
  const progressPerGate =
    (progressEnd - progressStart) / GATE_PIPELINE.length;

  const gateSettings = job.data.gateSettings ?? {};

  for (let i = 0; i < GATE_PIPELINE.length; i++) {
    const gate = GATE_PIPELINE[i]!;

    const disableReason = getGateDisableReason(gate.name, gateSettings);
    if (disableReason) {
      results.push(skippedGateResult(gate.name, disableReason));
      continue;
    }
    if (pipelineAborted) {
      results.push(skippedGateResult(gate.name, "Skipped due to previous gate failure"));
      continue;
    }

    logger.info(`Running gate: ${gate.name}`, {
      jobId: job.data.jobId,
      gate: gate.name,
    });

    try {
      const result = await executeGate({
        gate,
        vm,
        language,
        timeoutMs: vmConfig.defaultGateTimeoutMs,
        diff,
        testSuites,
        stepDefinitionsPublic,
        stepDefinitionsHidden,
      });
      results.push(result);

      logger.info(`Gate completed: ${gate.name}`, {
        jobId: job.data.jobId,
        gate: gate.name,
        status: result.status,
        durationMs: result.durationMs,
      });

      // Check fail-fast (disabled in ZTACO mode — agent sees ALL issues at once)
      if (shouldAbortAfterResult({ ztacoMode, gate, result })) {
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

      results.push(buildGateExceptionResult(gate.name, error));

      if (shouldAbortAfterException(ztacoMode, gate)) {
        pipelineAborted = true;
      }
    }

    // Update progress
    const progress = Math.round(progressStart + progressPerGate * (i + 1));
    await job.updateProgress(progress);
  }

  return results;
}
