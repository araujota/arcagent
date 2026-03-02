import { Job } from "bullmq";
import { buildGateSarif, buildBddSarif } from "../lib/sarif";
import { sanitizeShellArg } from "../lib/shellSanitize";
import { DiffContext } from "../lib/diffContext";
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

    if (abortedByLeg) {
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

          const candidateCounts = extractHighCriticalCounts(gate);
          if (candidateCounts) {
            policy.candidate = candidateCounts;
          }

          if (gate.status === "fail") {
            const baselineCommit = await resolveBaselineCommit(args.vm, args.baseCommitSha, args.candidateCommitSha);
            if (baselineCommit) {
              const baseline = await runSnykBaselineComparison({
                vm: args.vm,
                language: args.language,
                timeoutMs: vmConfig.defaultGateTimeoutMs,
                diff: args.diff,
                candidateCommitSha: args.candidateCommitSha,
                baselineCommitSha: baselineCommit,
              });
              policy.baselineCommit = baselineCommit;
              if (baseline.counts) {
                policy.baseline = baseline.counts;
              }
              if (baseline.error) {
                receiptStatus = "error";
                summaryLine = "Snyk baseline comparison failed";
                rawBody = baseline.error;
              } else if (baseline.counts && candidateCounts) {
                const candidateTotal = candidateCounts.highCount + candidateCounts.criticalCount;
                const baselineTotal = baseline.counts.highCount + baseline.counts.criticalCount;
                const delta = candidateTotal - baselineTotal;
                policy.deltaHighCritical = delta;
                if (delta <= 0) {
                  receiptStatus = "pass";
                  summaryLine = "PASS";
                  rawBody = undefined;
                } else {
                  receiptStatus = "fail";
                  summaryLine = `Snyk introduced ${delta} new high/critical issue(s)`;
                }
              }
            } else {
              policy.baselineReason = "missing_baseline_commit";
            }
          }

          const legacyStatus = receiptStatusToLegacyGateStatus(receiptStatus);
          legacyGates.push({
            ...gate,
            status: legacyStatus,
            summary: summaryLine,
          });

          receipt = makeReceipt({
            args,
            spec,
            orderIndex: i,
            status: receiptStatus,
            startedAt,
            completedAt: Date.now(),
            summaryLine,
            blocking: receiptStatus === "skipped_policy" ? false : spec.blocking,
            rawBody,
            sarifJson: buildGateSarif({
              ...gate,
              status: legacyStatus,
              summary: summaryLine,
            }),
            policyJson: JSON.stringify(policy),
            metadataJson: safeStringify(gate.details),
          });
          break;
        }
        case "sonarqube_new_code": {
          const gate = await runSonarQubeGate(args.vm, args.language, vmConfig.defaultGateTimeoutMs, args.diff);
          legacyGates.push(gate);
          receipt = gateToReceipt(args, spec, i, gate, startedAt, {
            mode: "new_code_only",
            strategy: "sonar_pr_analysis",
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
      status: testReceipt.status === "pass" ? "pass" : testReceipt.status === "warning" ? "error" : testReceipt.status === "skipped_policy" ? "skipped" : testReceipt.status === "unreached" ? "skipped" : testReceipt.status,
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
  const mappedStatus = mapGateStatus(gate.status);
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
    blocking: mappedStatus === "skipped_policy" ? false : spec.blocking,
    policyJson: policy ? JSON.stringify(policy) : undefined,
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

function extractHighCriticalCounts(gate: GateResult): { highCount: number; criticalCount: number } | undefined {
  const details = gate.details as Record<string, unknown> | undefined;
  if (!details) return undefined;
  const high = details.highCount;
  const critical = details.criticalCount;
  if (typeof high === "number" && typeof critical === "number") {
    return { highCount: high, criticalCount: critical };
  }
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
  counts?: { highCount: number; criticalCount: number };
  error?: string;
}> {
  try {
    const safeBaseline = sanitizeShellArg(args.baselineCommitSha, "commitSha", "baselineCommitSha");
    await args.vm.exec(`cd /workspace && git checkout -f ${safeBaseline}`, 30_000);
    const baselineGate = await runSnykGate(args.vm, args.language, args.timeoutMs, args.diff);
    if (baselineGate.status === "error") {
      return { error: baselineGate.summary };
    }
    const counts = extractHighCriticalCounts(baselineGate);
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
