import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

interface FeedbackResponse {
  feedbackJson: string | null;
  verificationStatus: string;
  attemptNumber?: number;
  hiddenFailureMechanisms?: Array<{
    key: string;
    label: string;
    count: number;
    guidance: string;
  }>;
  validationReceipts?: Array<{
    orderIndex: number;
    legKey: string;
    status: string;
    summaryLine: string;
    normalized?: {
      tool: "sonarqube" | "snyk";
      blocking: {
        isBlocking: boolean;
        reasonCode: string;
        reasonText: string;
        threshold: string;
        comparedToBaseline: boolean;
      };
      counts: {
        critical: number;
        high: number;
        medium: number;
        low: number;
        bugs: number;
        codeSmells: number;
        complexityDelta: number;
        introducedTotal: number;
      };
      issues: Array<{
        severity: string;
        isBlocking: boolean;
        file?: string;
        line?: number;
        message: string;
      }>;
      truncated: boolean;
    };
  }>;
}

interface ParsedFeedback {
  overallStatus?: string;
  attemptNumber?: number;
  attemptsRemaining?: number;
  gates?: Array<{ gate?: string; status?: string; issues?: unknown[] }>;
  testResults?: Array<{
    status?: string;
    featureName?: string;
    scenarioName?: string;
    visibility?: string;
    output?: string;
  }>;
  actionItems?: unknown[];
  validationReceipts?: Array<{
    orderIndex?: number;
    legKey?: string;
    status?: string;
    summaryLine?: string;
  }>;
  hiddenFailureMechanisms?: unknown[];
}

const MAX_NORMALIZED_ISSUES = 20;
const MAX_HIDDEN_MECHANISMS = 10;

function parseFeedbackJson(feedbackJson: string): ParsedFeedback | null {
  try {
    return JSON.parse(feedbackJson) as ParsedFeedback;
  } catch {
    return null;
  }
}

function buildSummaryHeader(feedback: ParsedFeedback): string {
  return [
    "# Verification Feedback",
    "",
    `**Overall Status:** ${feedback.overallStatus ?? "unknown"}`,
    `**Attempt:** ${feedback.attemptNumber ?? "?"} | **Remaining:** ${feedback.attemptsRemaining ?? "?"}`,
    "",
  ].join("\n");
}

function buildGateSummary(feedback: ParsedFeedback): string {
  if (!Array.isArray(feedback.gates) || feedback.gates.length === 0) return "";
  const lines = ["## Gate Summary", "", "| Gate | Status | Issues |", "|------|--------|--------|"];
  for (const gate of feedback.gates) {
    lines.push(`| ${gate.gate ?? "unknown"} | ${gate.status ?? "unknown"} | ${gate.issues?.length ?? 0} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildFailedScenarioLines(testResults: NonNullable<ParsedFeedback["testResults"]>): string[] {
  const failed = testResults.filter((result) => result.status === "fail");
  if (failed.length === 0) return [];
  const lines: string[] = ["### Failed Scenarios", ""];
  for (const result of failed) {
    lines.push(`- **${result.featureName ?? "Unknown Feature"} > ${result.scenarioName ?? "Unknown Scenario"}** [${result.visibility ?? "unknown"}]`);
    if (result.output) lines.push(`  \`\`\`\n${result.output}\n  \`\`\``);
  }
  return lines;
}

function buildTestResultsSection(feedback: ParsedFeedback): string {
  if (!Array.isArray(feedback.testResults) || feedback.testResults.length === 0) return "";
  const failedCount = feedback.testResults.filter((result) => result.status === "fail").length;
  const passedCount = feedback.testResults.filter((result) => result.status === "pass").length;
  const lines = ["## Test Results", `**Passed:** ${passedCount} | **Failed:** ${failedCount}`, ""];
  lines.push(...buildFailedScenarioLines(feedback.testResults));
  return lines.join("\n");
}

function buildActionItemsSection(feedback: ParsedFeedback): string {
  if (!Array.isArray(feedback.actionItems) || feedback.actionItems.length === 0) return "";
  const lines: string[] = ["", "## Action Items (prioritized — fix in this order)", ""];
  for (const [index, actionItem] of feedback.actionItems.entries()) {
    lines.push(`${index + 1}. ${String(actionItem)}`);
  }
  return lines.join("\n");
}

function buildValidationReceiptsSection(feedback: ParsedFeedback): string {
  if (!Array.isArray(feedback.validationReceipts) || feedback.validationReceipts.length === 0) return "";
  const ordered = [...feedback.validationReceipts].sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
  const lines = ["", "## Validation Receipts", ""];
  for (const receipt of ordered) {
    lines.push(`- [${receipt.orderIndex ?? "?"}] ${receipt.legKey ?? "unknown"}: ${String(receipt.status ?? "unknown").toUpperCase()} — ${receipt.summaryLine ?? ""}`);
  }
  return lines.join("\n");
}

function buildNormalizedIssuesList(receipt: NonNullable<FeedbackResponse["validationReceipts"]>[number]): string[] {
  if (!receipt.normalized || receipt.normalized.issues.length === 0) return [];
  const lines = ["- Top Issues:"];
  for (const issue of receipt.normalized.issues.slice(0, MAX_NORMALIZED_ISSUES)) {
    const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : "(no file)";
    lines.push(`  - [${issue.severity.toUpperCase()}${issue.isBlocking ? ", BLOCKING" : ""}] ${location} — ${issue.message}`);
  }
  if (receipt.normalized.truncated) lines.push("  - ... additional normalized issues omitted");
  return lines;
}

function buildNormalizedReceiptSection(receipt: NonNullable<FeedbackResponse["validationReceipts"]>[number]): string {
  const normalized = receipt.normalized!;
  const lines = [
    `### [${receipt.orderIndex}] ${receipt.legKey}`,
    `- Blocking: ${normalized.blocking.isBlocking ? "yes" : "no"}`,
    `- Reason: ${normalized.blocking.reasonCode} — ${normalized.blocking.reasonText}`,
    `- Compared to Baseline: ${normalized.blocking.comparedToBaseline ? "yes" : "no"}`,
    `- Introduced: ${normalized.counts.introducedTotal} (critical=${normalized.counts.critical}, high=${normalized.counts.high}, medium=${normalized.counts.medium}, low=${normalized.counts.low})`,
  ];
  if (normalized.tool === "sonarqube") {
    lines.push(`- Sonar Metrics: bugs=${normalized.counts.bugs}, codeSmells=${normalized.counts.codeSmells}, complexityDelta=${normalized.counts.complexityDelta}`);
  }
  lines.push(...buildNormalizedIssuesList(receipt), "");
  return lines.join("\n");
}

function buildNormalizedReceiptsSection(result: FeedbackResponse): string {
  const receiptSource = Array.isArray(result.validationReceipts) ? result.validationReceipts : [];
  const scannerReceipts = receiptSource
    .filter((receipt) => receipt.normalized && (receipt.normalized.tool === "sonarqube" || receipt.normalized.tool === "snyk"))
    .sort((a, b) => a.orderIndex - b.orderIndex);
  if (scannerReceipts.length === 0) return "";
  const lines: string[] = ["", "## Normalized Blocking Receipts", ""];
  for (const receipt of scannerReceipts) {
    lines.push(buildNormalizedReceiptSection(receipt));
  }
  return lines.join("\n");
}

function formatHiddenMechanism(mechanism: unknown): string {
  const label = typeof (mechanism as { label?: unknown }).label === "string"
    ? String((mechanism as { label: string }).label)
    : "Unknown edge case";
  const count = typeof (mechanism as { count?: unknown }).count === "number"
    ? String((mechanism as { count: number }).count)
    : "?";
  const guidance = typeof (mechanism as { guidance?: unknown }).guidance === "string"
    ? String((mechanism as { guidance: string }).guidance)
    : "Harden boundary conditions and error handling.";
  return `- **${label}** (${count}): ${guidance}`;
}

function resolveHiddenMechanisms(feedback: ParsedFeedback, result: FeedbackResponse): unknown[] {
  if (Array.isArray(feedback.hiddenFailureMechanisms) && feedback.hiddenFailureMechanisms.length > 0) {
    return feedback.hiddenFailureMechanisms;
  }
  if (Array.isArray(result.hiddenFailureMechanisms) && result.hiddenFailureMechanisms.length > 0) {
    return result.hiddenFailureMechanisms;
  }
  return [];
}

function buildHiddenMechanismsSection(feedback: ParsedFeedback, result: FeedbackResponse): string {
  const hiddenMechanisms = resolveHiddenMechanisms(feedback, result);
  if (hiddenMechanisms.length === 0) return "";
  return [
    "",
    "## Hidden Failure Mechanisms (safe summary)",
    "",
    ...hiddenMechanisms.slice(0, MAX_HIDDEN_MECHANISMS).map(formatHiddenMechanism),
  ].join("\n");
}

function buildFeedbackText(feedback: ParsedFeedback, result: FeedbackResponse): string {
  return [
    buildSummaryHeader(feedback),
    buildGateSummary(feedback),
    buildTestResultsSection(feedback),
    buildActionItemsSection(feedback),
    buildValidationReceiptsSection(feedback),
    buildNormalizedReceiptsSection(result),
    buildHiddenMechanismsSection(feedback, result),
  ].filter(Boolean).join("\n");
}

export function registerGetSubmissionFeedback(server: McpServer): void {
  registerTool(
    server,
    "get_submission_feedback",
    "Get structured feedback from the most recent failed verification for a bounty. Returns prioritized action items, per-file issues, remaining attempts, and detailed test output for public and hidden scenarios.",
    {
      bountyId: z.string().describe("The bounty ID"),
    },
    async (args: { bountyId: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:read");

      try {
        const result = await callConvex<FeedbackResponse>(
          "/api/mcp/verifications/feedback",
          { bountyId: args.bountyId },
        );

        if (!result.feedbackJson) {
          return {
            content: [{
              type: "text" as const,
              text: `No feedback available. Verification status: ${result.verificationStatus}`,
            }],
          };
        }

        const feedback = parseFeedbackJson(result.feedbackJson);
        if (!feedback) {
          return {
            content: [{
              type: "text" as const,
              text: `# Verification Feedback\n\nStructured feedback could not be parsed. Raw data:\n\n\`\`\`\n${result.feedbackJson.slice(0, 2000)}\n\`\`\``,
            }],
          };
        }

        return { content: [{ type: "text" as const, text: buildFeedbackText(feedback, result) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to get feedback";
        return {
          content: [{ type: "text" as const, text: `Failed to get feedback: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
