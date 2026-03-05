import { Job } from "bullmq";
import { buildGateSarif, buildBddSarif } from "../lib/sarif";
import { sanitizeShellArg } from "../lib/shellSanitize";
import { DiffContext } from "../lib/diffContext";
import {
  normalizeSonarOutput,
  normalizeSnykOutput,
  SnykSeverityCounts,
} from "../lib/receiptNormalization";
import { logger } from "../index";
import {
  GateResult,
  StepResult,
  TestSuiteInput,
  ValidationReceipt,
  VerificationJobData,
} from "../queue/jobQueue";
import { VMHandle } from "../vm/firecracker";
import { getVMConfig } from "../vm/vmConfig";
import { runBuildGate } from "./buildGate";
import { runLintGate } from "./lintGate";
import { runTypecheckGate } from "./typecheckGate";
import { runSecurityGate } from "./securityGate";
import { runMemoryGate } from "./memoryGate";
import { runSnykGate } from "./snykGate";
import { runSonarQubeGate } from "./sonarqubeGate";
import { runTestGate } from "./testGate";

export interface LegRunnerResult {
  receipts: ValidationReceipt[];
  legacyGates: GateResult[];
  steps: StepResult[];
}

type ReceiptCallback = (receipt: ValidationReceipt) => Promise<void>;

interface RunLegsArgs {
  vm: VMHandle;
  language: string;
  job: Job<VerificationJobData>;
  diff: DiffContext | null;
  testSuites?: TestSuiteInput[];
  stepDefinitionsPublic?: string;
  stepDefinitionsHidden?: string;
  attemptNumber: number;
  candidateCommitSha: string;
  baseCommitSha?: string;
  onReceipt?: ReceiptCallback;
}

interface LegSpec {
  key: string;
  blocking: boolean;
}

const LEG_SPECS: LegSpec[] = [
  { key: "prepare_environment", blocking: true },
  { key: "build", blocking: true },
  { key: "lint_no_new_errors", blocking: true },
  { key: "typecheck_no_new_errors", blocking: true },
  { key: "security_no_new_high_critical", blocking: true },
  { key: "memory", blocking: true },
  { key: "snyk_no_new_high_critical", blocking: true },
  { key: "sonarqube_new_code", blocking: true },
  { key: "bdd_public", blocking: true },
  { key: "bdd_hidden", blocking: true },
  { key: "regression_no_new_failures", blocking: true },
];

const ALWAYS_RUN_LEGS_AFTER_ABORT = new Set<string>([
  "snyk_no_new_high_critical",
  "sonarqube_new_code",
]);

const ADVISORY_LEGS = new Set<string>([
  "lint_no_new_errors",
  "typecheck_no_new_errors",
  "security_no_new_high_critical",
  "memory",
  "snyk_no_new_high_critical",
  "sonarqube_new_code",
]);

export async function runVerificationLegs(args: RunLegsArgs): Promise<LegRunnerResult> {
  const receipts: ValidationReceipt[] = [];
  const legacyGates: GateResult[] = [];
  const allSteps: StepResult[] = [];
  const vmConfig = getVMConfig(args.language);

  const progressStart = 25;
  const progressEnd = 95;
  const progressPerLeg = (progressEnd - progressStart) / LEG_SPECS.length;

  let abortedByLeg: string | null = null;
  const state: {
    bddPublicSteps: StepResult[];
    bddHiddenSteps: StepResult[];
    allSteps: StepResult[];
  } = {
    bddPublicSteps: [],
    bddHiddenSteps: [],
    allSteps,
  };

  for (let i = 0; i < LEG_SPECS.length; i++) {
    const spec = LEG_SPECS[i]!;
    const receipt = await runVerificationLegIteration({
      args,
      spec,
      orderIndex: i,
      abortedByLeg,
      vmConfig,
      state,
      legacyGates,
    });
    receipts.push(receipt);
    if (args.onReceipt) await args.onReceipt(receipt);

    if (receipt.blocking && receipt.status !== "pass") {
      abortedByLeg = spec.key;
    }

    await args.job.updateProgress(Math.round(progressStart + progressPerLeg * (i + 1)));
  }

  // Legacy projection: synthesize a single test gate from BDD + regression.
  const testReceipt = receipts.find((r) => r.legKey === "regression_no_new_failures")
    ?? receipts.find((r) => r.legKey === "bdd_hidden")
    ?? receipts.find((r) => r.legKey === "bdd_public");
  if (testReceipt) {
    legacyGates.push({
      gate: "test",
      status: receiptStatusToLegacyGateStatus(testReceipt.status),
      durationMs: testReceipt.durationMs,
      summary: testReceipt.summaryLine,
      details: {
        legKey: testReceipt.legKey,
        policy: testReceipt.policyJson ? safeParse(testReceipt.policyJson) : undefined,
      },
      steps: state.allSteps,
    });
  }

  return { receipts, legacyGates, steps: state.allSteps };
}

type LegRuntimeState = {
  bddPublicSteps: StepResult[];
  bddHiddenSteps: StepResult[];
  allSteps: StepResult[];
};

type LegExecutionParams = {
  args: RunLegsArgs;
  spec: LegSpec;
  orderIndex: number;
  startedAt: number;
  vmConfig: ReturnType<typeof getVMConfig>;
  state: LegRuntimeState;
  legacyGates: GateResult[];
};

type LegExecutor = (params: LegExecutionParams) => Promise<ValidationReceipt>;

const LEG_EXECUTORS: Record<string, LegExecutor> = {
  prepare_environment: runPrepareEnvironmentLeg,
  build: runBuildVerificationLeg,
  lint_no_new_errors: runLintVerificationLeg,
  typecheck_no_new_errors: runTypecheckVerificationLeg,
  security_no_new_high_critical: runSecurityVerificationLeg,
  memory: runMemoryVerificationLeg,
  snyk_no_new_high_critical: runSnykVerificationLeg,
  sonarqube_new_code: runSonarVerificationLeg,
  bdd_public: runPublicBddLeg,
  bdd_hidden: runHiddenBddLeg,
  regression_no_new_failures: runRegressionVerificationLeg,
};

async function runVerificationLegIteration(args: {
  args: RunLegsArgs;
  spec: LegSpec;
  orderIndex: number;
  abortedByLeg: string | null;
  vmConfig: ReturnType<typeof getVMConfig>;
  state: LegRuntimeState;
  legacyGates: GateResult[];
}): Promise<ValidationReceipt> {
  if (args.abortedByLeg && !ALWAYS_RUN_LEGS_AFTER_ABORT.has(args.spec.key)) {
    const now = Date.now();
    return makeReceipt({
      args: args.args,
      spec: args.spec,
      orderIndex: args.orderIndex,
      status: "unreached",
      startedAt: now,
      completedAt: now,
      summaryLine: "UNREACHED",
      blocking: args.spec.blocking,
      unreachedByLegKey: args.abortedByLeg,
    });
  }
  return runHandledVerificationLeg(args);
}

async function runHandledVerificationLeg(args: {
  args: RunLegsArgs;
  spec: LegSpec;
  orderIndex: number;
  vmConfig: ReturnType<typeof getVMConfig>;
  state: LegRuntimeState;
  legacyGates: GateResult[];
}): Promise<ValidationReceipt> {
  const startedAt = Date.now();
  try {
    return await executeVerificationLeg({
      args: args.args,
      spec: args.spec,
      orderIndex: args.orderIndex,
      startedAt,
      vmConfig: args.vmConfig,
      state: args.state,
      legacyGates: args.legacyGates,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeReceipt({
      args: args.args,
      spec: args.spec,
      orderIndex: args.orderIndex,
      status: "error",
      startedAt,
      completedAt: Date.now(),
      summaryLine: `Unexpected error in ${args.spec.key}`,
      rawBody: message,
      blocking: args.spec.blocking,
    });
  }
}

async function executeVerificationLeg(params: LegExecutionParams): Promise<ValidationReceipt> {
  const executor = LEG_EXECUTORS[params.spec.key];
  if (!executor) {
    return makeReceipt({
      args: params.args,
      spec: params.spec,
      orderIndex: params.orderIndex,
      status: "error",
      startedAt: params.startedAt,
      completedAt: Date.now(),
      summaryLine: `Unhandled leg: ${params.spec.key}`,
      blocking: params.spec.blocking,
    });
  }
  return executor(params);
}

async function runPrepareEnvironmentLeg(params: LegExecutionParams): Promise<ValidationReceipt> {
  return makeReceipt({
    args: params.args,
    spec: params.spec,
    orderIndex: params.orderIndex,
    status: "pass",
    startedAt: params.startedAt,
    completedAt: Date.now(),
    summaryLine: "PASS",
    blocking: params.spec.blocking,
    policyJson: JSON.stringify({ mode: "standardized_prepare" }),
  });
}

async function runStandardGateLeg(
  params: LegExecutionParams,
  runGate: (vm: VMHandle, language: string, timeoutMs: number, diff: DiffContext | null) => Promise<GateResult>,
  policy?: Record<string, unknown>,
): Promise<ValidationReceipt> {
  const gate = await runGate(
    params.args.vm,
    params.args.language,
    params.vmConfig.defaultGateTimeoutMs,
    params.args.diff,
  );
  params.legacyGates.push(gate);
  return gateToReceipt(
    params.args,
    params.spec,
    params.orderIndex,
    gate,
    params.startedAt,
    policy,
  );
}

async function runBuildVerificationLeg(params: LegExecutionParams): Promise<ValidationReceipt> {
  return runStandardGateLeg(params, runBuildGate);
}

async function runLintVerificationLeg(params: LegExecutionParams): Promise<ValidationReceipt> {
  return runStandardGateLeg(params, runLintGate, {
    mode: "no_new_errors",
    strategy: "diff_scoped",
  });
}

async function runTypecheckVerificationLeg(params: LegExecutionParams): Promise<ValidationReceipt> {
  return runStandardGateLeg(params, runTypecheckGate, {
    mode: "no_new_errors",
    strategy: "diff_scoped",
  });
}

async function runSecurityVerificationLeg(params: LegExecutionParams): Promise<ValidationReceipt> {
  return runStandardGateLeg(params, runSecurityGate, {
    mode: "no_new_high_critical",
    strategy: "diff_scoped_plus_dependency_scanners",
  });
}

async function runMemoryVerificationLeg(params: LegExecutionParams): Promise<ValidationReceipt> {
  return runStandardGateLeg(params, runMemoryGate);
}

function emptySnykCounts(): SnykSeverityCounts {
  return {
    criticalCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
  };
}

function diffSnykCounts(candidate: SnykSeverityCounts, baseline: SnykSeverityCounts): SnykSeverityCounts {
  return {
    criticalCount: Math.max(0, candidate.criticalCount - baseline.criticalCount),
    highCount: Math.max(0, candidate.highCount - baseline.highCount),
    mediumCount: Math.max(0, candidate.mediumCount - baseline.mediumCount),
    lowCount: Math.max(0, candidate.lowCount - baseline.lowCount),
  };
}

type SnykLegState = {
  receiptStatus: ValidationReceipt["status"];
  summaryLine: string;
  rawBody?: string;
  blocking: boolean;
  processFailureReason?: string;
  introducedCounts?: SnykSeverityCounts;
  baselineCounts?: SnykSeverityCounts;
  comparedToBaseline: boolean;
};

function initializeSnykLegState(params: LegExecutionParams, gate: GateResult): SnykLegState {
  const mappedStatus = mapGateStatus(gate.status);
  return {
    receiptStatus: mappedStatus,
    summaryLine: mappedStatus === "pass" ? "PASS" : gate.summary,
    rawBody: mappedStatus === "pass" ? undefined : extractRawBody(gate),
    blocking: mappedStatus === "skipped_policy" ? false : params.spec.blocking,
    processFailureReason: extractAdvisoryProcessFailureReason(params.spec, gate),
    introducedCounts: extractSnykSeverityCounts(gate),
    comparedToBaseline: false,
  };
}

async function applySnykBaselinePolicy(args: {
  params: LegExecutionParams;
  state: SnykLegState;
  policy: Record<string, unknown>;
}): Promise<void> {
  if (args.state.processFailureReason || !args.state.introducedCounts) return;
  const baselineCommit = await resolveBaselineCommit(
    args.params.args.vm,
    args.params.args.baseCommitSha,
    args.params.args.candidateCommitSha,
  );
  if (!baselineCommit) {
    args.state.processFailureReason = "Snyk baseline commit could not be resolved";
    args.state.receiptStatus = "skipped_policy_due_process";
    args.state.summaryLine = args.state.processFailureReason;
    args.state.rawBody = args.state.processFailureReason;
    args.state.blocking = false;
    args.policy.baselineReason = "missing_baseline_commit";
    return;
  }
  args.policy.baselineCommit = baselineCommit;
  const baseline = await runSnykBaselineComparison({
    vm: args.params.args.vm,
    language: args.params.args.language,
    timeoutMs: args.params.vmConfig.defaultGateTimeoutMs,
    diff: args.params.args.diff,
    candidateCommitSha: args.params.args.candidateCommitSha,
    baselineCommitSha: baselineCommit,
  });
  if (baseline.error) {
    args.state.processFailureReason = "Snyk baseline comparison failed";
    args.state.receiptStatus = "skipped_policy_due_process";
    args.state.summaryLine = args.state.processFailureReason;
    args.state.rawBody = baseline.error;
    args.state.blocking = false;
    return;
  }
  if (!baseline.counts || !args.state.introducedCounts) return;
  args.state.comparedToBaseline = true;
  args.state.baselineCounts = baseline.counts;
  args.state.introducedCounts = diffSnykCounts(args.state.introducedCounts, baseline.counts);
}

function applySnykDeltaPolicy(args: {
  state: SnykLegState;
  candidateCounts?: SnykSeverityCounts;
  policy: Record<string, unknown>;
}): void {
  if (args.state.processFailureReason) {
    args.state.receiptStatus = "skipped_policy_due_process";
    args.state.blocking = false;
    args.policy.processFailureReason = args.state.processFailureReason;
    return;
  }
  if (!args.state.introducedCounts) return;
  const deltaHighCritical = args.state.introducedCounts.highCount + args.state.introducedCounts.criticalCount;
  const deltaMinor = args.state.introducedCounts.mediumCount + args.state.introducedCounts.lowCount;
  args.policy.candidate = args.candidateCounts;
  if (args.state.baselineCounts) args.policy.baseline = args.state.baselineCounts;
  args.policy.deltaCounts = args.state.introducedCounts;
  args.policy.deltaHighCritical = deltaHighCritical;
  args.policy.deltaMinor = deltaMinor;
  if (deltaHighCritical > 0) {
    args.state.receiptStatus = "fail";
    args.state.summaryLine = `Snyk introduced ${deltaHighCritical} new high/critical issue(s)`;
    args.state.blocking = true;
    return;
  }
  args.state.receiptStatus = "pass";
  args.state.summaryLine = "PASS";
  args.state.blocking = false;
  args.state.rawBody = undefined;
}

async function runSnykVerificationLeg(params: LegExecutionParams): Promise<ValidationReceipt> {
  const gate = await runSnykGate(
    params.args.vm,
    params.args.language,
    params.vmConfig.defaultGateTimeoutMs,
    params.args.diff,
  );
  const policy: Record<string, unknown> = {
    mode: "no_new_high_critical",
    strategy: "baseline_delta",
  };
  const candidateCounts = extractSnykSeverityCounts(gate);
  const state = initializeSnykLegState(params, gate);
  await applySnykBaselinePolicy({ params, state, policy });
  applySnykDeltaPolicy({ state, candidateCounts, policy });

  const snykFindings = extractSnykFindings(gate);
  const normalized = normalizeSnykOutput({
    introducedCounts: state.processFailureReason ? emptySnykCounts() : state.introducedCounts ?? emptySnykCounts(),
    comparedToBaseline: state.comparedToBaseline,
    scaFindings: snykFindings.scaFindings,
    sastFindings: snykFindings.sastFindings,
    processFailureReason: state.processFailureReason,
    summaryLine: state.summaryLine,
    issueBudget: 20,
  });

  const legacyStatus = receiptStatusToLegacyGateStatus(state.receiptStatus);
  params.legacyGates.push({
    ...gate,
    status: legacyStatus,
    summary: state.summaryLine,
    details: {
      ...(gate.details ?? {}),
      normalized,
    },
  });

  return makeReceipt({
    args: params.args,
    spec: params.spec,
    orderIndex: params.orderIndex,
    status: state.receiptStatus,
    startedAt: params.startedAt,
    completedAt: Date.now(),
    summaryLine: state.summaryLine,
    blocking: state.blocking,
    rawBody: state.rawBody,
    sarifJson: buildGateSarif({
      ...gate,
      status: legacyStatus,
      summary: state.summaryLine,
    }),
    policyJson: JSON.stringify(policy),
    metadataJson: safeStringify(gate.details),
    normalizedJson: JSON.stringify(normalized),
  });
}

async function runSonarVerificationLeg(params: LegExecutionParams): Promise<ValidationReceipt> {
  const gate = await runSonarQubeGate(
    params.args.vm,
    params.args.language,
    params.vmConfig.defaultGateTimeoutMs,
    params.args.diff,
  );
  const processFailureReason = extractAdvisoryProcessFailureReason(params.spec, gate);
  let receiptStatus = mapGateStatus(gate.status);
  let summaryLine = receiptStatus === "pass" ? "PASS" : gate.summary;
  let rawBody = receiptStatus === "pass" ? undefined : extractRawBody(gate);
  let blocking = receiptStatus === "skipped_policy" ? false : params.spec.blocking;

  if (processFailureReason) {
    receiptStatus = "skipped_policy_due_process";
    blocking = false;
    summaryLine = gate.summary;
    rawBody = extractRawBody(gate);
  }

  const normalized = normalizeSonarOutput({
    issues: extractSonarIssues(gate),
    metrics: extractSonarMetrics(gate),
    processFailureReason,
    summaryLine,
    qualityGateFailed: receiptStatus === "fail",
    issueBudget: 20,
  });

  params.legacyGates.push({
    ...gate,
    details: {
      ...(gate.details ?? {}),
      normalized,
    },
  });

  return makeReceipt({
    args: params.args,
    spec: params.spec,
    orderIndex: params.orderIndex,
    status: receiptStatus,
    startedAt: params.startedAt,
    completedAt: Date.now(),
    summaryLine,
    rawBody,
    sarifJson: buildGateSarif(gate),
    blocking,
    policyJson: JSON.stringify({
      mode: "new_code_only",
      strategy: "sonar_pr_analysis",
      ...(processFailureReason ? { processFailureReason } : {}),
    }),
    metadataJson: safeStringify(gate.details),
    normalizedJson: JSON.stringify(normalized),
  });
}

async function runBddLeg(
  params: LegExecutionParams,
  visibility: "public" | "hidden",
): Promise<ValidationReceipt> {
  const suites = (params.args.testSuites ?? []).filter((suite) => suite.visibility === visibility);
  if (suites.length === 0) {
    return makeReceipt({
      args: params.args,
      spec: params.spec,
      orderIndex: params.orderIndex,
      status: "skipped_policy",
      startedAt: params.startedAt,
      completedAt: Date.now(),
      summaryLine: visibility === "public" ? "No public suites; skipped by policy" : "No hidden suites; skipped by policy",
      blocking: false,
      policyJson: JSON.stringify({
        reason: visibility === "public" ? "no_public_suites" : "no_hidden_suites",
      }),
    });
  }
  const gate = await runTestGate(
    params.args.vm,
    params.args.language,
    params.vmConfig.defaultGateTimeoutMs,
    params.args.diff,
    suites,
    visibility === "public" ? params.args.stepDefinitionsPublic : undefined,
    visibility === "hidden" ? params.args.stepDefinitionsHidden : undefined,
  );
  const bddSteps = (gate.steps ?? []).map((step) => ({ ...step, visibility }));
  params.state.allSteps.push(...bddSteps);
  if (visibility === "public") {
    params.state.bddPublicSteps = bddSteps;
  } else {
    params.state.bddHiddenSteps = bddSteps;
  }
  return makeReceipt({
    args: params.args,
    spec: params.spec,
    orderIndex: params.orderIndex,
    status: mapGateStatus(gate.status),
    startedAt: params.startedAt,
    completedAt: Date.now(),
    summaryLine: gate.status === "pass" ? "PASS" : gate.summary,
    blocking: params.spec.blocking,
    rawBody: gate.status === "pass" ? undefined : buildBddRawBody(bddSteps, gate),
    sarifJson: buildBddSarif(params.spec.key, bddSteps),
    policyJson: JSON.stringify({ mode: visibility === "public" ? "bdd_public" : "bdd_hidden" }),
    metadataJson: safeStringify(gate.details),
  });
}

async function runPublicBddLeg(params: LegExecutionParams): Promise<ValidationReceipt> {
  return runBddLeg(params, "public");
}

async function runHiddenBddLeg(params: LegExecutionParams): Promise<ValidationReceipt> {
  return runBddLeg(params, "hidden");
}

async function runRegressionVerificationLeg(params: LegExecutionParams): Promise<ValidationReceipt> {
  const regression = await runRegressionLeg({
    ...params.args,
    candidateSteps: [...params.state.bddPublicSteps, ...params.state.bddHiddenSteps],
    timeoutMs: params.vmConfig.defaultGateTimeoutMs,
  });
  return makeReceipt({
    args: params.args,
    spec: params.spec,
    orderIndex: params.orderIndex,
    status: regression.status,
    startedAt: params.startedAt,
    completedAt: Date.now(),
    summaryLine: regression.status === "pass" ? "PASS" : regression.summary,
    blocking: params.spec.blocking,
    rawBody: regression.rawBody,
    sarifJson: regression.sarifJson,
    policyJson: regression.policyJson,
    metadataJson: regression.metadataJson,
  });
}

function gateToReceipt(
  args: RunLegsArgs,
  spec: LegSpec,
  orderIndex: number,
  gate: GateResult,
  startedAt: number,
  policy?: Record<string, unknown>,
): ValidationReceipt {
  let mappedStatus = mapGateStatus(gate.status);
  let blocking = mappedStatus === "skipped_policy" ? false : spec.blocking;
  const processFailureReason = extractAdvisoryProcessFailureReason(spec, gate);
  if (processFailureReason) {
    mappedStatus = "skipped_policy_due_process";
    blocking = false;
  }

  const effectivePolicy = processFailureReason
    ? {
        ...(policy ?? {}),
        processFailureReason,
      }
    : policy;

  return makeReceipt({
    args,
    spec,
    orderIndex,
    status: mappedStatus,
    startedAt,
    completedAt: Date.now(),
    summaryLine: mappedStatus === "pass" ? "PASS" : gate.summary,
    rawBody: mappedStatus === "pass" ? undefined : extractRawBody(gate),
    sarifJson: buildGateSarif(gate),
    blocking,
    policyJson: effectivePolicy ? JSON.stringify(effectivePolicy) : undefined,
    metadataJson: safeStringify(gate.details),
  });
}

function makeReceipt(args: {
  args: RunLegsArgs;
  spec: LegSpec;
  orderIndex: number;
  status: ValidationReceipt["status"];
  startedAt: number;
  completedAt: number;
  summaryLine: string;
  blocking: boolean;
  unreachedByLegKey?: string;
  rawBody?: string;
  sarifJson?: string;
  policyJson?: string;
  metadataJson?: string;
  normalizedJson?: string;
}): ValidationReceipt {
  return {
    verificationId: args.args.job.data.verificationId,
    jobId: args.args.job.data.jobId,
    submissionId: args.args.job.data.submissionId,
    bountyId: args.args.job.data.bountyId,
    attemptNumber: args.args.attemptNumber,
    legKey: args.spec.key,
    orderIndex: args.orderIndex,
    status: args.status,
    blocking: args.blocking,
    unreachedByLegKey: args.unreachedByLegKey,
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    durationMs: Math.max(0, args.completedAt - args.startedAt),
    summaryLine: args.summaryLine,
    rawBody: args.rawBody,
    sarifJson: args.sarifJson,
    policyJson: args.policyJson,
    metadataJson: args.metadataJson,
    normalizedJson: args.normalizedJson,
  };
}

function mapGateStatus(status: GateResult["status"]): ValidationReceipt["status"] {
  if (status === "skipped") return "skipped_policy";
  if (status === "pass") return "pass";
  if (status === "fail") return "fail";
  return "error";
}

function receiptStatusToLegacyGateStatus(status: ValidationReceipt["status"]): GateResult["status"] {
  if (status === "pass") return "pass";
  if (status === "fail") return "fail";
  if (status === "error" || status === "warning") return "error";
  return "skipped";
}

function extractSnykSeverityCounts(gate: GateResult): SnykSeverityCounts | undefined {
  const details = gate.details as Record<string, unknown> | undefined;
  if (!details) return undefined;
  const low = details.lowCount;
  const medium = details.mediumCount;
  const high = details.highCount;
  const critical = details.criticalCount;
  if (
    typeof low === "number" &&
    typeof medium === "number" &&
    typeof high === "number" &&
    typeof critical === "number"
  ) {
    return {
      lowCount: low,
      mediumCount: medium,
      highCount: high,
      criticalCount: critical,
    };
  }
  return undefined;
}

function extractSnykFindings(gate: GateResult): {
  scaFindings: unknown[];
  sastFindings: unknown[];
} {
  const details = gate.details as Record<string, unknown> | undefined;
  const findings = details?.findings as Record<string, unknown> | undefined;
  const sca = Array.isArray(findings?.sca) ? findings?.sca : [];
  const sast = Array.isArray(findings?.sast) ? findings?.sast : [];
  return { scaFindings: sca, sastFindings: sast };
}

function extractSonarMetrics(gate: GateResult): Record<string, number> {
  const details = gate.details as Record<string, unknown> | undefined;
  const metrics = details?.metrics;
  if (!metrics || typeof metrics !== "object") return {};
  const record = metrics as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function extractSonarIssues(gate: GateResult): Array<Record<string, unknown>> {
  const details = gate.details as Record<string, unknown> | undefined;
  const issues = details?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter((issue): issue is Record<string, unknown> => Boolean(issue) && typeof issue === "object");
}

function extractAdvisoryProcessFailureReason(spec: LegSpec, gate: GateResult): string | undefined {
  if (!ADVISORY_LEGS.has(spec.key)) return undefined;
  if (gate.status === "error") return gate.summary;
  if (gate.status === "skipped") return gate.summary;
  const details = gate.details as Record<string, unknown> | undefined;
  if (details && typeof details.reasonCode === "string") return gate.summary;
  return undefined;
}

function extractRawBody(gate: GateResult): string | undefined {
  if (!gate.details) return gate.summary;
  const details = gate.details as Record<string, unknown>;
  const candidate = details.rawOutput
    ?? details.output
    ?? details.stderr
    ?? details.stdout;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  return gate.summary;
}

function buildBddRawBody(steps: StepResult[], gate: GateResult): string {
  const failed = steps.filter((step) => step.status === "fail" || step.status === "error");
  if (failed.length === 0) return gate.summary;
  return failed
    .map((step) => `${step.featureName} > ${step.scenarioName}\n${step.output ?? "(no output)"}`)
    .join("\n\n");
}

function scenarioId(step: StepResult): string {
  return `${step.visibility}::${step.featureName}::${step.scenarioName}`;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function safeStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

async function resolveBaselineCommit(
  vm: VMHandle,
  providedBaseCommitSha: string | undefined,
  candidateCommitSha: string,
): Promise<string | undefined> {
  if (providedBaseCommitSha) return providedBaseCommitSha;

  try {
    const safeCandidate = sanitizeShellArg(candidateCommitSha, "commitSha", "candidateCommitSha");
    const result = await vm.exec(
      `cd /workspace && git merge-base origin/HEAD ${safeCandidate} 2>/dev/null || true`,
      20_000,
    );
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

async function runRegressionLeg(args: RunLegsArgs & {
  candidateSteps: StepResult[];
  timeoutMs: number;
}): Promise<{
  status: ValidationReceipt["status"];
  summary: string;
  rawBody?: string;
  sarifJson?: string;
  policyJson?: string;
  metadataJson?: string;
}> {
  const suites = args.testSuites ?? [];
  if (suites.length === 0) {
    return {
      status: "skipped_policy",
      summary: "No suites available for regression analysis",
      policyJson: JSON.stringify({ reason: "no_suites" }),
    };
  }

  const baselineCommit = await resolveBaselineCommit(args.vm, args.baseCommitSha, args.candidateCommitSha);
  if (!baselineCommit) {
    return {
      status: "skipped_policy",
      summary: "No baseline commit could be resolved for regression analysis",
      policyJson: JSON.stringify({ reason: "missing_baseline_commit" }),
    };
  }

  const baselineSteps: StepResult[] = [];
  try {
    const safeBaseline = sanitizeShellArg(baselineCommit, "commitSha", "baselineCommitSha");
    await args.vm.exec(`cd /workspace && git checkout -f ${safeBaseline}`, 30_000);

    const publicSuites = suites.filter((s) => s.visibility === "public");
    const hiddenSuites = suites.filter((s) => s.visibility === "hidden");

    if (publicSuites.length > 0) {
      const baselinePublic = await runTestGate(
        args.vm,
        args.language,
        args.timeoutMs,
        args.diff,
        publicSuites,
        args.stepDefinitionsPublic,
        undefined,
      );
      baselineSteps.push(
        ...(baselinePublic.steps ?? []).map((step): StepResult => ({ ...step, visibility: "public" })),
      );
    }

    if (hiddenSuites.length > 0) {
      const baselineHidden = await runTestGate(
        args.vm,
        args.language,
        args.timeoutMs,
        args.diff,
        hiddenSuites,
        undefined,
        args.stepDefinitionsHidden,
      );
      baselineSteps.push(
        ...(baselineHidden.steps ?? []).map((step): StepResult => ({ ...step, visibility: "hidden" })),
      );
    }
  } catch (err) {
    logger.warn("Regression baseline execution failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "error",
      summary: "Regression baseline execution failed",
      rawBody: err instanceof Error ? err.message : String(err),
      policyJson: JSON.stringify({ baselineCommit }),
    };
  } finally {
    try {
      const safeCandidate = sanitizeShellArg(args.candidateCommitSha, "commitSha", "candidateCommitSha");
      await args.vm.exec(`cd /workspace && git checkout -f ${safeCandidate}`, 30_000);
    } catch (restoreErr) {
      logger.warn("Failed to restore candidate commit after regression baseline run", {
        error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
      });
    }
  }

  const candidateFailSet = new Set(
    args.candidateSteps
      .filter((step) => step.status === "fail" || step.status === "error")
      .map(scenarioId),
  );
  const baselineFailSet = new Set(
    baselineSteps
      .filter((step) => step.status === "fail" || step.status === "error")
      .map(scenarioId),
  );

  const newFailures = Array.from(candidateFailSet).filter((id) => !baselineFailSet.has(id));
  const resolvedFailures = Array.from(baselineFailSet).filter((id) => !candidateFailSet.has(id));
  const unchangedFailures = Array.from(candidateFailSet).filter((id) => baselineFailSet.has(id));

  const policy = {
    mode: "no_new_regressions",
    baselineCommit,
    counts: {
      newFailures: newFailures.length,
      resolvedFailures: resolvedFailures.length,
      unchangedFailures: unchangedFailures.length,
    },
    newFailures,
    resolvedFailures,
    unchangedFailures,
  };

  if (newFailures.length > 0) {
    const sarif = JSON.stringify({
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "regression_no_new_failures" } },
          results: newFailures.map((id) => ({
            ruleId: "test.regression.new_failure",
            level: "error",
            message: { text: `New failing scenario introduced: ${id}` },
          })),
        },
      ],
    });

    return {
      status: "fail",
      summary: `Regression detected ${newFailures.length} newly failing scenario(s)`,
      rawBody: newFailures.join("\n"),
      sarifJson: sarif,
      policyJson: JSON.stringify(policy),
      metadataJson: JSON.stringify({ baselineFailures: Array.from(baselineFailSet) }),
    };
  }

  return {
    status: "pass",
    summary: "PASS",
    policyJson: JSON.stringify(policy),
    metadataJson: JSON.stringify({ baselineFailures: Array.from(baselineFailSet) }),
  };
}

async function runSnykBaselineComparison(args: {
  vm: VMHandle;
  language: string;
  timeoutMs: number;
  diff: DiffContext | null;
  candidateCommitSha: string;
  baselineCommitSha: string;
}): Promise<{
  counts?: SnykSeverityCounts;
  error?: string;
}> {
  try {
    const safeBaseline = sanitizeShellArg(args.baselineCommitSha, "commitSha", "baselineCommitSha");
    await args.vm.exec(`cd /workspace && git checkout -f ${safeBaseline}`, 30_000);
    const baselineGate = await runSnykGate(args.vm, args.language, args.timeoutMs, args.diff);
    if (baselineGate.status === "error") {
      return { error: baselineGate.summary };
    }
    const counts = extractSnykSeverityCounts(baselineGate);
    if (!counts) {
      return { error: "Unable to parse baseline high/critical counts" };
    }
    return { counts };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      const safeCandidate = sanitizeShellArg(args.candidateCommitSha, "commitSha", "candidateCommitSha");
      await args.vm.exec(`cd /workspace && git checkout -f ${safeCandidate}`, 30_000);
    } catch (restoreErr) {
      logger.warn("Failed to restore candidate commit after Snyk baseline run", {
        error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
      });
    }
  }
}
