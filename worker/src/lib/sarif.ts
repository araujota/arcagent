import { GateResult, StepResult } from "../queue/jobQueue";

interface SarifResultItem {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: { text: string };
  locations?: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: { startLine?: number; startColumn?: number };
    };
  }>;
  properties?: Record<string, unknown>;
}

interface SarifRun {
  tool: {
    driver: {
      name: string;
      version?: string;
      rules?: Array<{ id: string; shortDescription?: { text: string } }>;
    };
  };
  results: SarifResultItem[];
}

interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
}

function baseLog(run: SarifRun): SarifLog {
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [run],
  };
}

function toLevel(status: string): "error" | "warning" | "note" {
  if (status === "fail" || status === "error") return "error";
  if (status === "warning") return "warning";
  return "note";
}

function extractIssues(details: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  if (!details) return [];
  const normalized = details.normalizedIssues;
  if (!Array.isArray(normalized)) return [];
  return normalized.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>;
}

function buildLocations(file?: string, line?: number, column?: number): SarifResultItem["locations"] {
  if (!file) {
    return undefined;
  }
  return [
    {
      physicalLocation: {
        artifactLocation: { uri: file },
        region: {
          startLine: line,
          startColumn: column,
        },
      },
    },
  ];
}

function buildIssueResult(issue: Record<string, unknown>, gate: GateResult): SarifResultItem {
  const file = typeof issue.file === "string" ? issue.file : undefined;
  const line = typeof issue.line === "number" ? issue.line : undefined;
  const column = typeof issue.column === "number" ? issue.column : undefined;
  const message = typeof issue.message === "string" ? issue.message : gate.summary;
  const ruleId = typeof issue.rule === "string" ? issue.rule : `${gate.gate}.issue`;
  const severity = typeof issue.severity === "string" ? issue.severity : gate.status;

  return {
    ruleId,
    level: severity === "warning" ? "warning" : "error",
    message: { text: message },
    locations: buildLocations(file, line, column),
    properties: { gate: gate.gate },
  };
}

function buildGateRun(gateName: string, results: SarifResultItem[]): SarifRun {
  return {
    tool: { driver: { name: gateName } },
    results,
  };
}

function buildSummaryResult(gate: GateResult): SarifResultItem {
  return {
    ruleId: `${gate.gate}.summary`,
    level: toLevel(gate.status),
    message: { text: gate.summary },
    properties: { gate: gate.gate },
  };
}

export function buildGateSarif(gate: GateResult): string | undefined {
  const issues = extractIssues(gate.details);
  const results = issues.map((issue) => buildIssueResult(issue, gate));

  if (results.length === 0 && gate.status !== "pass") {
    results.push(buildSummaryResult(gate));
  }

  return JSON.stringify(baseLog(buildGateRun(gate.gate, results)));
}

export function buildBddSarif(legKey: string, steps: StepResult[]): string {
  const results: SarifResultItem[] = [];

  for (const step of steps) {
    if (step.status === "pass" || step.status === "skip") continue;

    results.push({
      ruleId: "test.scenario_failure",
      level: "error",
      message: {
        text: step.output
          ? `${step.featureName} > ${step.scenarioName}: ${step.output}`
          : `${step.featureName} > ${step.scenarioName} failed`,
      },
      properties: {
        scenarioName: step.scenarioName,
        featureName: step.featureName,
        visibility: step.visibility,
        stepNumber: step.stepNumber,
      },
    });
  }

  return JSON.stringify(
    baseLog(buildGateRun(legKey, results)),
  );
}
