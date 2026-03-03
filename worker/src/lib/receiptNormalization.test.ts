import { describe, expect, it } from "vitest";
import { normalizeSonarOutput, normalizeSnykOutput } from "./receiptNormalization";

describe("normalizeSnykOutput", () => {
  it("marks high/critical deltas as blocking", () => {
    const output = normalizeSnykOutput({
      introducedCounts: {
        criticalCount: 1,
        highCount: 2,
        mediumCount: 3,
        lowCount: 4,
      },
      comparedToBaseline: true,
      scaFindings: [
        { id: "CVE-1", severity: "critical", title: "Critical vuln", packageName: "leftpad" },
        { id: "CVE-2", severity: "medium", title: "Medium vuln", packageName: "lodash" },
      ],
      sastFindings: [
        {
          ruleId: "js.sqli",
          properties: { severity: "high" },
          message: { text: "SQL injection risk" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src/db.ts" }, region: { startLine: 12 } } }],
        },
      ],
      summaryLine: "Snyk introduced 3 high/critical issue(s)",
    });

    expect(output.tool).toBe("snyk");
    expect(output.blocking.isBlocking).toBe(true);
    expect(output.blocking.reasonCode).toBe("new_high_critical_introduced");
    expect(output.counts.critical).toBe(1);
    expect(output.counts.high).toBe(2);
    expect(output.counts.medium).toBe(3);
    expect(output.counts.low).toBe(4);
    expect(output.counts.introducedTotal).toBe(10);
    expect(output.issues[0]?.isBlocking).toBe(true);
  });

  it("keeps minor-only deltas non-blocking", () => {
    const output = normalizeSnykOutput({
      introducedCounts: {
        criticalCount: 0,
        highCount: 0,
        mediumCount: 2,
        lowCount: 1,
      },
      comparedToBaseline: true,
      scaFindings: [{ severity: "medium", title: "Minor vuln" }],
      summaryLine: "PASS",
    });

    expect(output.blocking.isBlocking).toBe(false);
    expect(output.blocking.reasonCode).toBe("within_threshold");
    expect(output.counts.introducedTotal).toBe(3);
  });

  it("uses process_failure reason and suppresses issue list", () => {
    const findings = Array.from({ length: 30 }, (_, i) => ({
      severity: i % 2 === 0 ? "high" : "low",
      title: `Issue ${i}`,
      filePath: `src/f${i}.ts`,
      line: i + 1,
    }));

    const output = normalizeSnykOutput({
      introducedCounts: {
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
      },
      comparedToBaseline: false,
      scaFindings: findings,
      processFailureReason: "Snyk baseline comparison failed",
      summaryLine: "Snyk baseline comparison failed",
      issueBudget: 20,
    });

    expect(output.blocking.isBlocking).toBe(false);
    expect(output.blocking.reasonCode).toBe("process_failure");
    expect(output.issues).toHaveLength(0);
    expect(output.truncated).toBe(false);
  });

  it("caps issue payload to top 20 and sorts by severity", () => {
    const findings = Array.from({ length: 30 }, (_, i) => ({
      severity: i % 2 === 0 ? "high" : "low",
      title: `Issue ${i}`,
      filePath: `src/f${i}.ts`,
      line: i + 1,
    }));

    const output = normalizeSnykOutput({
      introducedCounts: {
        criticalCount: 0,
        highCount: 1,
        mediumCount: 0,
        lowCount: 0,
      },
      comparedToBaseline: true,
      scaFindings: findings,
      summaryLine: "Snyk introduced 1 new high/critical issue(s)",
      issueBudget: 20,
    });

    expect(output.issues).toHaveLength(20);
    expect(output.truncated).toBe(true);
    expect(output.issues[0]?.severity).toBe("high");
  });
});

describe("normalizeSonarOutput", () => {
  it("marks quality-gate failure as blocking and maps metrics", () => {
    const output = normalizeSonarOutput({
      qualityGateFailed: true,
      summaryLine: "SonarQube quality gate failed: bugs=2",
      metrics: {
        new_bugs: 2,
        new_code_smells: 3,
        new_complexity: 4,
      },
      issues: [
        {
          type: "BUG",
          severity: "CRITICAL",
          component: "src/service.ts",
          line: 22,
          rule: "typescript:S123",
          message: "Potential null dereference",
        },
      ],
    });

    expect(output.tool).toBe("sonarqube");
    expect(output.blocking.isBlocking).toBe(true);
    expect(output.blocking.reasonCode).toBe("quality_gate_failed");
    expect(output.counts.bugs).toBe(2);
    expect(output.counts.codeSmells).toBe(3);
    expect(output.counts.complexityDelta).toBe(4);
    expect(output.counts.introducedTotal).toBe(9);
    expect(output.issues[0]?.tool).toBe("sonarqube");
  });

  it("returns non-blocking process failure", () => {
    const output = normalizeSonarOutput({
      qualityGateFailed: false,
      summaryLine: "SonarQube quality gate polling timed out",
      processFailureReason: "SonarQube quality gate polling timed out",
    });

    expect(output.blocking.isBlocking).toBe(false);
    expect(output.blocking.reasonCode).toBe("process_failure");
    expect(output.counts.introducedTotal).toBe(0);
  });
});
