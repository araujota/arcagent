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
  let bddPublicSteps: StepResult[] = [];
  let bddHiddenSteps: StepResult[] = [];

  for (let i = 0; i < LEG_SPECS.length; i++) {
    const spec = LEG_SPECS[i]!;

    if (abortedByLeg && !ALWAYS_RUN_LEGS_AFTER_ABORT.has(spec.key)) {
      const now = Date.now();
      const unreached = makeReceipt({
        args,
        spec,
        orderIndex: i,
        status: "unreached",
        startedAt: now,
        completedAt: now,
        summaryLine: "UNREACHED",
        blocking: spec.blocking,
        unreachedByLegKey: abortedByLeg,
      });
      receipts.push(unreached);
      if (args.onReceipt) await args.onReceipt(unreached);
      await args.job.updateProgress(Math.round(progressStart + progressPerLeg * (i + 1)));
      continue;
    }

    const startedAt = Date.now();
    let receipt: ValidationReceipt;

    try {
      switch (spec.key) {
        case "prepare_environment": {
          // Keep prepare leg explicit for standardized ordering/auditing.
          receipt = makeReceipt({
            args,
            spec,
            orderIndex: i,
            status: "pass",
            startedAt,
            completedAt: Date.now(),
            summaryLine: "PASS",
            blocking: spec.blocking,
            policyJson: JSON.stringify({ mode: "standardized_prepare" }),
          });
          break;
        }
        case "build": {
          const gate = await runBuildGate(args.vm, args.language, vmConfig.defaultGateTimeoutMs, args.diff);
          legacyGates.push(gate);
          receipt = gateToReceipt(args, spec, i, gate, startedAt);
          break;
        }
        case "lint_no_new_errors": {
          const gate = await runLintGate(args.vm, args.language, vmConfig.defaultGateTimeoutMs, args.diff);
          legacyGates.push(gate);
          receipt = gateToReceipt(args, spec, i, gate, startedAt, {
            mode: "no_new_errors",
            strategy: "diff_scoped",
          });
          break;
        }
        case "typecheck_no_new_errors": {
          const gate = await runTypecheckGate(args.vm, args.language, vmConfig.defaultGateTimeoutMs, args.diff);
          legacyGates.push(gate);
          receipt = gateToReceipt(args, spec, i, gate, startedAt, {
            mode: "no_new_errors",
            strategy: "diff_scoped",
          });
          break;
        }
        case "security_no_new_high_critical": {
          const gate = await runSecurityGate(args.vm, args.language, vmConfig.defaultGateTimeoutMs, args.diff);
          legacyGates.push(gate);
          receipt = gateToReceipt(args, spec, i, gate, startedAt, {
            mode: "no_new_high_critical",
            strategy: "diff_scoped_plus_dependency_scanners",
          });
          break;
        }
        case "memory": {
          const gate = await runMemoryGate(args.vm, args.language, vmConfig.defaultGateTimeoutMs, args.diff);
          legacyGates.push(gate);
          receipt = gateToReceipt(args, spec, i, gate, startedAt);
          break;
        }
        case "snyk_no_new_high_critical": {
          const gate = await runSnykGate(args.vm, args.language, vmConfig.defaultGateTimeoutMs, args.diff);
          const policy: Record<string, unknown> = {
            mode: "no_new_high_critical",
            strategy: "baseline_delta",
          };

          let receiptStatus = mapGateStatus(gate.status);
          let summaryLine = receiptStatus === "pass" ? "PASS" : gate.summary;
          let rawBody = receiptStatus === "pass" ? undefined : extractRawBody(gate);
          let blocking = receiptStatus === "skipped_policy" ? false : spec.blocking;
          let processFailureReason = extractAdvisoryProcessFailureReason(spec, gate);

          const candidateCounts = extractSnykSeverityCounts(gate);
          let introducedCounts = candidateCounts;
          let baselineCounts: SnykSeverityCounts | undefined;
          let comparedToBaseline = false;

          if (!processFailureReason && candidateCounts) {
            const baselineCommit = await resolveBaselineCommit(args.vm, args.baseCommitSha, args.candidateCommitSha);
            if (baselineCommit) {
              policy.baselineCommit = baselineCommit;
              const baseline = await runSnykBaselineComparison({
                vm: args.vm,
                language: args.language,
                timeoutMs: vmConfig.defaultGateTimeoutMs,
                diff: args.diff,
                candidateCommitSha: args.candidateCommitSha,
                baselineCommitSha: baselineCommit,
              });
              if (baseline.error) {
                processFailureReason = "Snyk baseline comparison failed";
                receiptStatus = "skipped_policy_due_process";
                summaryLine = processFailureReason;
                rawBody = baseline.error;
                blocking = false;
              } else if (baseline.counts) {
                comparedToBaseline = true;
                baselineCounts = baseline.counts;
                introducedCounts = {
                  criticalCount: Math.max(0, candidateCounts.criticalCount - baseline.counts.criticalCount),
                  highCount: Math.max(0, candidateCounts.highCount - baseline.counts.highCount),
                  mediumCount: Math.max(0, candidateCounts.mediumCount - baseline.counts.mediumCount),
                  lowCount: Math.max(0, candidateCounts.lowCount - baseline.counts.lowCount),
                };
              }
            } else {
              processFailureReason = "Snyk baseline commit could not be resolved";
              receiptStatus = "skipped_policy_due_process";
              summaryLine = processFailureReason;
              rawBody = processFailureReason;
              blocking = false;
              policy.baselineReason = "missing_baseline_commit";
            }
          }

          if (!processFailureReason && introducedCounts) {
            const deltaHighCritical = introducedCounts.highCount + introducedCounts.criticalCount;
            const deltaMinor = introducedCounts.mediumCount + introducedCounts.lowCount;
            policy.candidate = candidateCounts;
            if (baselineCounts) policy.baseline = baselineCounts;
            policy.deltaCounts = introducedCounts;
            policy.deltaHighCritical = deltaHighCritical;
            policy.deltaMinor = deltaMinor;

            if (deltaHighCritical > 0) {
              receiptStatus = "fail";
              summaryLine = `Snyk introduced ${deltaHighCritical} new high/critical issue(s)`;
              blocking = true;
            } else {
              receiptStatus = "pass";
              summaryLine = "PASS";
              blocking = false;
              rawBody = undefined;
            }
          } else if (processFailureReason) {
            receiptStatus = "skipped_policy_due_process";
            blocking = false;
            policy.processFailureReason = processFailureReason;
          }

          const snykFindings = extractSnykFindings(gate);
          const normalized = normalizeSnykOutput({
            introducedCounts: processFailureReason
              ? {
                  criticalCount: 0,
                  highCount: 0,
                  mediumCount: 0,
                  lowCount: 0,
                }
              : introducedCounts ?? {
                  criticalCount: 0,
                  highCount: 0,
                  mediumCount: 0,
                  lowCount: 0,
                },
            comparedToBaseline,
            scaFindings: snykFindings.scaFindings,
            sastFindings: snykFindings.sastFindings,
            processFailureReason,
            summaryLine,
            issueBudget: 20,
          });

          const legacyStatus = receiptStatusToLegacyGateStatus(receiptStatus);
          legacyGates.push({
            ...gate,
            status: legacyStatus,
            summary: summaryLine,
            details: {
              ...(gate.details ?? {}),
              normalized,
            },
          });

          receipt = makeReceipt({
            args,
            spec,
            orderIndex: i,
            status: receiptStatus,
            startedAt,
            completedAt: Date.now(),
            summaryLine,
            blocking,
            rawBody,
            sarifJson: buildGateSarif({
              ...gate,
              status: legacyStatus,
              summary: summaryLine,
            }),
            policyJson: JSON.stringify(policy),
            metadataJson: safeStringify(gate.details),
            normalizedJson: JSON.stringify(normalized),
          });
          break;
        }
        case "sonarqube_new_code": {
          const gate = await runSonarQubeGate(args.vm, args.language, vmConfig.defaultGateTimeoutMs, args.diff);
          const processFailureReason = extractAdvisoryProcessFailureReason(spec, gate);
          let receiptStatus = mapGateStatus(gate.status);
          let summaryLine = receiptStatus === "pass" ? "PASS" : gate.summary;
          let rawBody = receiptStatus === "pass" ? undefined : extractRawBody(gate);
          let blocking = receiptStatus === "skipped_policy" ? false : spec.blocking;

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

          legacyGates.push({
            ...gate,
            details: {
              ...(gate.details ?? {}),
              normalized,
            },
          });

          receipt = makeReceipt({
            args,
            spec,
            orderIndex: i,
            status: receiptStatus,
            startedAt,
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
          break;
        }
        case "bdd_public": {
          const publicSuites = (args.testSuites ?? []).filter((s) => s.visibility === "public");
          if (publicSuites.length === 0) {
            receipt = makeReceipt({
              args,
              spec,
              orderIndex: i,
              status: "skipped_policy",
              startedAt,
              completedAt: Date.now(),
              summaryLine: "No public suites; skipped by policy",
              blocking: false,
              policyJson: JSON.stringify({ reason: "no_public_suites" }),
            });
            break;
          }

          const gate = await runTestGate(
            args.vm,
            args.language,
            vmConfig.defaultGateTimeoutMs,
            args.diff,
            publicSuites,
            args.stepDefinitionsPublic,
            undefined,
          );

          bddPublicSteps = (gate.steps ?? []).map((step) => ({ ...step, visibility: "public" }));
          allSteps.push(...bddPublicSteps);

          receipt = makeReceipt({
            args,
            spec,
            orderIndex: i,
            status: mapGateStatus(gate.status),
            startedAt,
            completedAt: Date.now(),
            summaryLine: gate.status === "pass" ? "PASS" : gate.summary,
            blocking: spec.blocking,
            rawBody: gate.status === "pass" ? undefined : buildBddRawBody(bddPublicSteps, gate),
            sarifJson: buildBddSarif(spec.key, bddPublicSteps),
            policyJson: JSON.stringify({ mode: "bdd_public" }),
            metadataJson: safeStringify(gate.details),
          });
          break;
        }
        case "bdd_hidden": {
          const hiddenSuites = (args.testSuites ?? []).filter((s) => s.visibility === "hidden");
          if (hiddenSuites.length === 0) {
            receipt = makeReceipt({
              args,
              spec,
              orderIndex: i,
              status: "skipped_policy",
              startedAt,
              completedAt: Date.now(),
              summaryLine: "No hidden suites; skipped by policy",
              blocking: false,
              policyJson: JSON.stringify({ reason: "no_hidden_suites" }),
            });
            break;
          }

          const gate = await runTestGate(
            args.vm,
            args.language,
            vmConfig.defaultGateTimeoutMs,
            args.diff,
            hiddenSuites,
            undefined,
            args.stepDefinitionsHidden,
          );

          bddHiddenSteps = (gate.steps ?? []).map((step) => ({ ...step, visibility: "hidden" }));
          allSteps.push(...bddHiddenSteps);

          receipt = makeReceipt({
            args,
            spec,
            orderIndex: i,
            status: mapGateStatus(gate.status),
            startedAt,
            completedAt: Date.now(),
            summaryLine: gate.status === "pass" ? "PASS" : gate.summary,
            blocking: spec.blocking,
            rawBody: gate.status === "pass" ? undefined : buildBddRawBody(bddHiddenSteps, gate),
            sarifJson: buildBddSarif(spec.key, bddHiddenSteps),
            policyJson: JSON.stringify({ mode: "bdd_hidden" }),
            metadataJson: safeStringify(gate.details),
          });
          break;
        }
        case "regression_no_new_failures": {
          const regression = await runRegressionLeg({
            ...args,
            candidateSteps: [...bddPublicSteps, ...bddHiddenSteps],
            timeoutMs: vmConfig.defaultGateTimeoutMs,
          });

          receipt = makeReceipt({
            args,
            spec,
            orderIndex: i,
            status: regression.status,
            startedAt,
            completedAt: Date.now(),
            summaryLine: regression.status === "pass" ? "PASS" : regression.summary,
            blocking: spec.blocking,
            rawBody: regression.rawBody,
            sarifJson: regression.sarifJson,
            policyJson: regression.policyJson,
            metadataJson: regression.metadataJson,
          });
          break;
        }
        default: {
          receipt = makeReceipt({
            args,
            spec,
            orderIndex: i,
            status: "error",
            startedAt,
            completedAt: Date.now(),
            summaryLine: `Unhandled leg: ${spec.key}`,
            blocking: spec.blocking,
          });
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      receipt = makeReceipt({
        args,
        spec,
        orderIndex: i,
        status: "error",
        startedAt,
        completedAt: Date.now(),
        summaryLine: `Unexpected error in ${spec.key}`,
        rawBody: message,
        blocking: spec.blocking,
      });
    }

    receipts.push(receipt);
    if (args.onReceipt) {
      await args.onReceipt(receipt);
    }

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
      steps: allSteps,
    });
  }

  return { receipts, legacyGates, steps: allSteps };
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
