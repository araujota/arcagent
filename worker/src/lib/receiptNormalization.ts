export type NormalizedTool = "sonarqube" | "snyk";

export type NormalizedSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface NormalizedBlocking {
  isBlocking: boolean;
  reasonCode: string;
  reasonText: string;
  threshold: string;
  comparedToBaseline: boolean;
}

export interface NormalizedCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  bugs: number;
  codeSmells: number;
  complexityDelta: number;
  introducedTotal: number;
}

export interface NormalizedIssue {
  tool: NormalizedTool;
  category: string;
  severity: NormalizedSeverity;
  isBlocking: boolean;
  file?: string;
  line?: number;
  rule?: string;
  message: string;
  suggestion?: string;
  introducedOnNewCode: boolean;
}

export interface NormalizedReceiptOutput {
  tool: NormalizedTool;
  blocking: NormalizedBlocking;
  counts: NormalizedCounts;
  issues: NormalizedIssue[];
  truncated: boolean;
}

export interface SnykSeverityCounts {
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

const SEVERITY_RANK: Record<NormalizedSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function sortIssues(issues: NormalizedIssue[]): NormalizedIssue[] {
  return [...issues].sort((a, b) => {
    if (a.isBlocking !== b.isBlocking) {
      return a.isBlocking ? -1 : 1;
    }
    return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  });
}

function capIssues(issues: NormalizedIssue[], budget: number): {
  issues: NormalizedIssue[];
  truncated: boolean;
} {
  const sorted = sortIssues(issues);
  if (sorted.length <= budget) return { issues: sorted, truncated: false };
  return { issues: sorted.slice(0, budget), truncated: true };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toSeverity(value: string | undefined): NormalizedSeverity {
  const normalized = (value ?? "").toLowerCase();
  if (normalized.includes("critical") || normalized === "error") return "critical";
  if (normalized.includes("high") || normalized === "warning") return "high";
  if (normalized.includes("medium") || normalized === "warn") return "medium";
  if (normalized.includes("low") || normalized === "note") return "low";
  return "info";
}

function toIssueLine(value: unknown): number | undefined {
  const n = asNumber(value);
  if (n === undefined) return undefined;
  const i = Math.floor(n);
  return i > 0 ? i : undefined;
}

function resolveSonarComplexityDelta(metrics: Record<string, number>): number {
  return (
    metrics.new_maintainability_issues ??
    metrics.new_cognitive_complexity ??
    metrics.new_complexity ??
    0
  );
}

function buildSonarBlocking(args: {
  processFailureReason?: string;
  qualityGateFailed: boolean;
  summaryLine: string;
}): NormalizedBlocking {
  if (args.processFailureReason) {
    return {
      isBlocking: false,
      reasonCode: "process_failure",
      reasonText: args.processFailureReason,
      threshold: "quality_gate=OK",
      comparedToBaseline: true,
    };
  }

  if (args.qualityGateFailed) {
    return {
      isBlocking: true,
      reasonCode: "quality_gate_failed",
      reasonText: args.summaryLine,
      threshold: "quality_gate=OK",
      comparedToBaseline: true,
    };
  }

  return {
    isBlocking: false,
    reasonCode: "quality_gate_passed",
    reasonText: args.summaryLine,
    threshold: "quality_gate=OK",
    comparedToBaseline: true,
  };
}

function normalizeSonarIssue(issue: unknown, qualityGateFailed: boolean): NormalizedIssue | null {
  const rec = asRecord(issue);
  if (!rec) {
    return null;
  }
  const type = asString(rec.type)?.toLowerCase();
  const category = type === "bug"
    ? "bug"
    : type === "code_smell"
      ? "code_smell"
      : "sonar_issue";
  const severity = toSeverity(asString(rec.severity));

  return {
    tool: "sonarqube",
    category,
    severity,
    isBlocking: qualityGateFailed && (severity === "critical" || category === "bug"),
    file: asString(rec.component) ?? asString(rec.file),
    line: toIssueLine(rec.line),
    rule: asString(rec.rule),
    message: asString(rec.message) ?? "Sonar issue detected on new code",
    suggestion: "Refactor to reduce complexity and resolve reliability/maintainability findings.",
    introducedOnNewCode: true,
  };
}

export function normalizeSnykOutput(args: {
  introducedCounts: SnykSeverityCounts;
  comparedToBaseline: boolean;
  scaFindings?: unknown[];
  sastFindings?: unknown[];
  processFailureReason?: string;
  summaryLine: string;
  issueBudget?: number;
}): NormalizedReceiptOutput {
  const budget = args.issueBudget ?? 20;
  const introduced = args.introducedCounts;
  const isBlocking = introduced.criticalCount + introduced.highCount > 0;

  const rawIssues: NormalizedIssue[] = [];

  if (!args.processFailureReason) {
    for (const finding of args.scaFindings ?? []) {
      const rec = asRecord(finding);
      if (!rec) continue;
      const severity = toSeverity(asString(rec.severity));
      rawIssues.push({
        tool: "snyk",
        category: "dependency_vulnerability",
        severity,
        isBlocking: severity === "critical" || severity === "high",
        file: asString(rec.packageName) ?? asString(rec.filePath),
        line: toIssueLine(rec.line),
        rule: asString(rec.id),
        message: asString(rec.title) ?? "Dependency vulnerability detected",
        suggestion: "Upgrade or patch the affected dependency.",
        introducedOnNewCode: true,
      });
    }

    for (const finding of args.sastFindings ?? []) {
      const rec = asRecord(finding);
      if (!rec) continue;
      const severity = toSeverity(asString(rec.severity) ?? asString(rec.level));
      const message = asString(asRecord(rec.message)?.text) ?? asString(rec.message) ?? "Code vulnerability detected";
      const location = asRecord(rec.location);
      const physical = asRecord(location?.physicalLocation);
      const artifact = asRecord(physical?.artifactLocation);
      const region = asRecord(physical?.region);

      rawIssues.push({
        tool: "snyk",
        category: "code_vulnerability",
        severity,
        isBlocking: severity === "critical" || severity === "high",
        file: asString(rec.path) ?? asString(artifact?.uri),
        line: toIssueLine(rec.line) ?? toIssueLine(region?.startLine),
        rule: asString(rec.ruleId),
        message,
        suggestion: "Apply the recommended secure coding remediation.",
        introducedOnNewCode: true,
      });
    }
  }

  const { issues, truncated } = capIssues(rawIssues, budget);

  const failureReason = args.processFailureReason;
  const blocking = failureReason
    ? {
        isBlocking: false,
        reasonCode: "process_failure",
        reasonText: failureReason,
        threshold: "new_high_critical_delta>0",
        comparedToBaseline: args.comparedToBaseline,
      }
    : isBlocking
      ? {
          isBlocking: true,
          reasonCode: "new_high_critical_introduced",
          reasonText: `Introduced ${introduced.criticalCount} critical and ${introduced.highCount} high issue(s).`,
          threshold: "new_high_critical_delta>0",
          comparedToBaseline: args.comparedToBaseline,
        }
      : {
          isBlocking: false,
          reasonCode: "within_threshold",
          reasonText: args.summaryLine,
          threshold: "new_high_critical_delta>0",
          comparedToBaseline: args.comparedToBaseline,
        };

  return {
    tool: "snyk",
    blocking,
    counts: {
      critical: introduced.criticalCount,
      high: introduced.highCount,
      medium: introduced.mediumCount,
      low: introduced.lowCount,
      bugs: 0,
      codeSmells: 0,
      complexityDelta: 0,
      introducedTotal:
        introduced.criticalCount +
        introduced.highCount +
        introduced.mediumCount +
        introduced.lowCount,
    },
    issues,
    truncated,
  };
}

export function normalizeSonarOutput(args: {
  issues?: unknown[];
  metrics?: Record<string, number>;
  processFailureReason?: string;
  summaryLine: string;
  qualityGateFailed: boolean;
  issueBudget?: number;
}): NormalizedReceiptOutput {
  const budget = args.issueBudget ?? 20;
  const metrics = args.metrics ?? {};
  const hasProcessFailure = Boolean(args.processFailureReason);

  const bugs = hasProcessFailure ? 0 : metrics.new_bugs ?? 0;
  const codeSmells = hasProcessFailure ? 0 : metrics.new_code_smells ?? 0;
  const complexityDelta = hasProcessFailure ? 0 : resolveSonarComplexityDelta(metrics);

  const rawIssues: NormalizedIssue[] = [];
  if (!hasProcessFailure) {
    for (const issue of args.issues ?? []) {
      const normalizedIssue = normalizeSonarIssue(issue, args.qualityGateFailed);
      if (normalizedIssue) {
        rawIssues.push(normalizedIssue);
      }
    }
  }

  const { issues, truncated } = capIssues(rawIssues, budget);

  const blocking = buildSonarBlocking(args);

  return {
    tool: "sonarqube",
    blocking,
    counts: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      bugs,
      codeSmells,
      complexityDelta,
      introducedTotal: bugs + codeSmells + complexityDelta,
    },
    issues,
    truncated,
  };
}
