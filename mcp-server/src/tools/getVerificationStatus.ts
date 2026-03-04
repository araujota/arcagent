import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { ConvexAgentVerification } from "../lib/types";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

const MAX_GATE_ISSUES = 50;
const MAX_NORMALIZED_ISSUES = 20;
const MAX_HIDDEN_MECHANISMS = 10;

interface ParsedFeedback {
  attemptNumber?: number;
  attemptsRemaining?: number;
  hiddenFailureMechanisms?: unknown[];
  actionItems?: unknown[];
}

interface StructuredFeedbackRender {
  text: string;
  renderedHiddenMechanisms: boolean;
}

function formatTimestamp(value?: number): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

function buildHeaderSection(v: ConvexAgentVerification): string {
  const lines: string[] = [
    "# Verification Status",
    "",
    `**ID:** ${v._id}`,
    `**Overall Status:** ${v.status}`,
  ];
  const started = formatTimestamp(v.startedAt);
  const completed = formatTimestamp(v.completedAt);
  if (started) lines.push(`**Started:** ${started}`);
  if (completed) lines.push(`**Completed:** ${completed}`);
  return lines.join("\n");
}

function buildWorkerSection(v: ConvexAgentVerification): string {
  if (!v.job) return "";
  const lines: string[] = ["", "## Worker Job", `**Job Status:** ${v.job.status}`];
  if (v.job.currentGate) lines.push(`**Current Gate:** ${v.job.currentGate}`);
  return lines.join("\n");
}

function formatGateStatusLabel(status: string): string {
  if (status === "passed") return "PASS";
  if (status === "failed") return "FAIL";
  return "WARN";
}

function buildGateIssuesSection(gateType: string, issues?: string[]): string {
  if (!issues || issues.length === 0) return "";
  const lines = [
    "",
    `**${gateType} issues:**`,
    ...issues.slice(0, MAX_GATE_ISSUES).map((issue) => `- ${issue}`),
  ];
  if (issues.length > MAX_GATE_ISSUES) {
    lines.push(`- ... and ${issues.length - MAX_GATE_ISSUES} more`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildGateDetailsSection(gateType: string, details: unknown): string {
  const detailsText = JSON.stringify(details, null, 2);
  return [
    `**${gateType} details:**`,
    `\`\`\`json`,
    detailsText.slice(0, 4000),
    `\`\`\``,
    "",
  ].join("\n");
}

function buildGateSection(v: ConvexAgentVerification): string {
  if (v.gates.length === 0) return "";
  const lines: string[] = ["", "## Gate Results", "", "| Gate | Status | Tool |", "|------|--------|------|"];
  for (const gate of v.gates) {
    lines.push(`| ${gate.gateType} | ${formatGateStatusLabel(gate.status)} | ${gate.tool} |`);
    const issuesBlock = buildGateIssuesSection(gate.gateType, gate.issues);
    if (issuesBlock) lines.push(issuesBlock);
    if (gate.details) lines.push(buildGateDetailsSection(gate.gateType, gate.details));
  }
  return lines.join("\n");
}

function buildNormalizedIssuesSection(receipt: NonNullable<ConvexAgentVerification["validationReceipts"]>[number]): string {
  if (!receipt.normalized || receipt.normalized.issues.length === 0) return "";
  const lines: string[] = ["", "**Top Normalized Issues:**"];
  for (const issue of receipt.normalized.issues.slice(0, MAX_NORMALIZED_ISSUES)) {
    const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : "(no file)";
    lines.push(`- [${issue.severity.toUpperCase()}${issue.isBlocking ? ", BLOCKING" : ""}] ${location} — ${issue.message}`);
  }
  if (receipt.normalized.truncated) {
    lines.push("- ... additional normalized issues omitted");
  }
  return lines.join("\n");
}

function buildSingleReceiptSection(receipt: NonNullable<ConvexAgentVerification["validationReceipts"]>[number]): string {
  const lines: string[] = [
    `### [${receipt.orderIndex}] ${receipt.legKey} — ${receipt.status.toUpperCase()}`,
    `- Blocking: ${receipt.blocking ? "yes" : "no"}`,
    `- Duration: ${receipt.durationMs}ms`,
  ];
  if (receipt.unreachedByLegKey) lines.push(`- Unreached by: ${receipt.unreachedByLegKey}`);
  if (receipt.status === "pass") {
    lines.push("- PASS", "");
    return lines.join("\n");
  }

  lines.push(`- Summary: ${receipt.summaryLine}`);
  if (receipt.rawBody) {
    lines.push("", "```", receipt.rawBody.slice(0, 8000), "```");
  }
  if (receipt.policy) {
    lines.push("", "**Policy:**", "```json", JSON.stringify(receipt.policy, null, 2).slice(0, 4000), "```");
  }
  if (receipt.normalized) {
    lines.push(
      "",
      "**Normalized Blocking:**",
      `- Tool: ${receipt.normalized.tool}`,
      `- Blocking: ${receipt.normalized.blocking.isBlocking ? "yes" : "no"}`,
      `- Reason: ${receipt.normalized.blocking.reasonCode} — ${receipt.normalized.blocking.reasonText}`,
      `- Threshold: ${receipt.normalized.blocking.threshold}`,
      `- Compared to Baseline: ${receipt.normalized.blocking.comparedToBaseline ? "yes" : "no"}`,
      `- Introduced: ${receipt.normalized.counts.introducedTotal} (critical=${receipt.normalized.counts.critical}, high=${receipt.normalized.counts.high}, medium=${receipt.normalized.counts.medium}, low=${receipt.normalized.counts.low})`,
    );
    if (receipt.normalized.tool === "sonarqube") {
      lines.push(`- Sonar Metrics: bugs=${receipt.normalized.counts.bugs}, codeSmells=${receipt.normalized.counts.codeSmells}, complexityDelta=${receipt.normalized.counts.complexityDelta}`);
    }
    const normalizedIssues = buildNormalizedIssuesSection(receipt);
    if (normalizedIssues) lines.push(normalizedIssues);
  }
  if (receipt.sarif) {
    lines.push("", "**SARIF:**", "```json", JSON.stringify(receipt.sarif, null, 2).slice(0, 4000), "```");
  }
  lines.push("");
  return lines.join("\n");
}

function buildValidationReceiptsSection(v: ConvexAgentVerification): string {
  if (!Array.isArray(v.validationReceipts) || v.validationReceipts.length === 0) return "";
  const lines: string[] = ["", "## Validation Receipts", ""];
  const ordered = [...v.validationReceipts].sort((a, b) => a.orderIndex - b.orderIndex);
  for (const receipt of ordered) {
    lines.push(buildSingleReceiptSection(receipt));
  }
  return lines.join("\n");
}

function buildFailedScenarioSection(steps: ConvexAgentVerification["steps"]): string {
  const failures = steps.filter((step) => step.status === "fail" || step.status === "error");
  if (failures.length === 0) return "";
  const lines: string[] = ["### Failed Scenarios", ""];
  for (const step of failures) {
    lines.push(`- **${step.featureName} > ${step.scenarioName}** [${step.visibility}] - ${step.status.toUpperCase()}`);
    if (step.output) lines.push(`  \`\`\`\n${step.output}\n  \`\`\``);
  }
  return lines.join("\n");
}

function buildTestResultsSection(v: ConvexAgentVerification): string {
  const steps = v.steps ?? [];
  if (steps.length === 0) return "";
  const passed = steps.filter((step) => step.status === "pass").length;
  const failed = steps.filter((step) => step.status === "fail").length;
  const lines = [
    "",
    `## Test Results (${steps.length} scenarios)`,
    `**Passed:** ${passed} | **Failed:** ${failed}`,
    "",
  ];
  const failures = buildFailedScenarioSection(steps);
  if (failures) lines.push(failures);
  return lines.join("\n");
}

function buildHiddenSummarySection(v: ConvexAgentVerification): string {
  if (!v.hiddenSummary) return "";
  return [
    "",
    "## Hidden Test Summary",
    `**Total:** ${v.hiddenSummary.total} | **Passed:** ${v.hiddenSummary.passed} | **Failed:** ${v.hiddenSummary.failed} | **Skipped:** ${v.hiddenSummary.skipped}`,
  ].join("\n");
}

function parseFeedbackJson(feedbackJson?: string): ParsedFeedback | null {
  if (!feedbackJson) return null;
  try {
    return JSON.parse(feedbackJson) as ParsedFeedback;
  } catch {
    return null;
  }
}

function toHiddenMechanismLines(hiddenMechanisms: unknown[]): string[] {
  return hiddenMechanisms.slice(0, MAX_HIDDEN_MECHANISMS).map((mechanism) => {
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
  });
}

function buildHiddenMechanismsSection(hiddenMechanisms: unknown[]): string {
  if (hiddenMechanisms.length === 0) return "";
  return [
    "### Hidden Failure Mechanisms (safe summary)",
    "",
    ...toHiddenMechanismLines(hiddenMechanisms),
    "",
  ].join("\n");
}

function buildActionItemsSection(actionItems: unknown[]): string {
  if (actionItems.length === 0) return "";
  const lines: string[] = ["### Action Items (prioritized)", ""];
  for (const [index, item] of actionItems.entries()) {
    lines.push(`${index + 1}. ${String(item)}`);
  }
  return lines.join("\n");
}

function buildStructuredFeedbackSection(v: ConvexAgentVerification): StructuredFeedbackRender {
  const parsed = parseFeedbackJson(v.feedbackJson);
  if (!parsed) return { text: "", renderedHiddenMechanisms: false };

  const lines: string[] = [
    "",
    "## Structured Feedback",
    "",
    `**Attempt:** ${parsed.attemptNumber ?? "?"} | **Remaining:** ${parsed.attemptsRemaining ?? "?"}`,
    "",
  ];

  let renderedHiddenMechanisms = false;
  if (Array.isArray(parsed.hiddenFailureMechanisms) && parsed.hiddenFailureMechanisms.length > 0) {
    lines.push(buildHiddenMechanismsSection(parsed.hiddenFailureMechanisms));
    renderedHiddenMechanisms = true;
  }
  if (Array.isArray(parsed.actionItems) && parsed.actionItems.length > 0) {
    lines.push(buildActionItemsSection(parsed.actionItems));
  }
  return { text: lines.join("\n"), renderedHiddenMechanisms };
}

function buildFallbackHiddenMechanismsSection(v: ConvexAgentVerification, alreadyRendered: boolean): string {
  if (alreadyRendered) return "";
  if (!Array.isArray(v.hiddenFailureMechanisms) || v.hiddenFailureMechanisms.length === 0) return "";
  return ["", "## Hidden Failure Mechanisms (safe summary)", "", ...toHiddenMechanismLines(v.hiddenFailureMechanisms)].join("\n");
}

function buildResultAndErrorSection(v: ConvexAgentVerification): string {
  const lines: string[] = [];
  if (v.result) lines.push("", "## Result", v.result);
  if (v.errorLog) lines.push("", "## Error Log", "```", v.errorLog.slice(0, 2000), "```");
  return lines.join("\n");
}

function buildPollingGuidance(status: string): string {
  const isTerminal = ["passed", "failed", "error", "timed_out"].includes(status);
  if (isTerminal) return "";
  return "\n---\n_Verification typically takes 2-5 minutes. Check again in ~15 seconds._\n";
}

function buildVerificationStatusText(v: ConvexAgentVerification): string {
  const sections = [
    buildHeaderSection(v),
    buildWorkerSection(v),
    buildGateSection(v),
    buildValidationReceiptsSection(v),
    buildTestResultsSection(v),
    buildHiddenSummarySection(v),
  ];
  const structuredFeedback = buildStructuredFeedbackSection(v);
  sections.push(structuredFeedback.text);
  sections.push(buildFallbackHiddenMechanismsSection(v, structuredFeedback.renderedHiddenMechanisms));
  sections.push(buildResultAndErrorSection(v));
  sections.push(buildPollingGuidance(v.status));
  return sections.filter(Boolean).join("\n");
}

export function registerGetVerificationStatus(server: McpServer): void {
  registerTool(
    server,
    "get_verification_status",
    "Check verification progress and results. Shows gate results (build, lint, typecheck, security, tests), verbose output for public and hidden scenarios, and structured feedback with prioritized action items.",
    {
      verificationId: z.string().optional().describe("The verification ID (from submit_solution)"),
      submissionId: z.string().optional().describe("The submission ID (alternative to verificationId)"),
    },
    async (args: { verificationId?: string; submissionId?: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:read");
      if (!args.verificationId && !args.submissionId) {
        return {
          content: [{ type: "text" as const, text: "Please provide either verificationId or submissionId." }],
          isError: true,
        };
      }

      try {
        const result = await callConvex<{ verification: ConvexAgentVerification }>(
          "/api/mcp/verifications/get",
          { verificationId: args.verificationId, submissionId: args.submissionId },
        );

        return { content: [{ type: "text" as const, text: buildVerificationStatusText(result.verification) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to get verification status";
        return {
          content: [{ type: "text" as const, text: `Failed to get verification status: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
