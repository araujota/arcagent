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

        let feedback;
        try {
          feedback = JSON.parse(result.feedbackJson);
        } catch {
          return {
            content: [{
              type: "text" as const,
              text: `# Verification Feedback\n\nStructured feedback could not be parsed. Raw data:\n\n\`\`\`\n${result.feedbackJson.slice(0, 2000)}\n\`\`\``,
            }],
          };
        }

        let text = `# Verification Feedback\n\n`;
        text += `**Overall Status:** ${feedback.overallStatus}\n`;
        text += `**Attempt:** ${feedback.attemptNumber} | **Remaining:** ${feedback.attemptsRemaining}\n\n`;

        // Gate summary
        if (feedback.gates && feedback.gates.length > 0) {
          text += `## Gate Summary\n\n`;
          text += `| Gate | Status | Issues |\n|------|--------|--------|\n`;
          for (const g of feedback.gates) {
            text += `| ${g.gate} | ${g.status} | ${g.issues?.length ?? 0} |\n`;
          }
          text += `\n`;
        }

        // Test results
        if (feedback.testResults && feedback.testResults.length > 0) {
          const failed = feedback.testResults.filter((t: { status: string }) => t.status === "fail");
          const passed = feedback.testResults.filter((t: { status: string }) => t.status === "pass");
          text += `## Test Results\n`;
          text += `**Passed:** ${passed.length} | **Failed:** ${failed.length}\n\n`;

          if (failed.length > 0) {
            text += `### Failed Scenarios\n\n`;
            for (const t of failed) {
              text += `- **${t.featureName} > ${t.scenarioName}** [${t.visibility}]\n`;
              if (t.output) text += `  \`\`\`\n${t.output}\n  \`\`\`\n`;
            }
          }
        }

        // Prioritized action items
        if (feedback.actionItems && feedback.actionItems.length > 0) {
          text += `\n## Action Items (prioritized — fix in this order)\n\n`;
          for (let i = 0; i < feedback.actionItems.length; i++) {
            text += `${i + 1}. ${feedback.actionItems[i]}\n`;
          }
        }

        if (Array.isArray(feedback.validationReceipts) && feedback.validationReceipts.length > 0) {
          text += `\n## Validation Receipts\n\n`;
          const ordered = [...feedback.validationReceipts].sort((a, b) => a.orderIndex - b.orderIndex);
          for (const receipt of ordered) {
            text += `- [${receipt.orderIndex}] ${receipt.legKey}: ${String(receipt.status).toUpperCase()} — ${receipt.summaryLine}\n`;
          }
        }

        const receiptSource = Array.isArray(result.validationReceipts) ? result.validationReceipts : [];
        if (receiptSource.length > 0) {
          const scannerReceipts = receiptSource
            .filter((r) => r.normalized && (r.normalized.tool === "sonarqube" || r.normalized.tool === "snyk"))
            .sort((a, b) => a.orderIndex - b.orderIndex);
          if (scannerReceipts.length > 0) {
            text += `\n## Normalized Blocking Receipts\n\n`;
            for (const receipt of scannerReceipts) {
              const normalized = receipt.normalized!;
              text += `### [${receipt.orderIndex}] ${receipt.legKey}\n`;
              text += `- Blocking: ${normalized.blocking.isBlocking ? "yes" : "no"}\n`;
              text += `- Reason: ${normalized.blocking.reasonCode} — ${normalized.blocking.reasonText}\n`;
              text += `- Compared to Baseline: ${normalized.blocking.comparedToBaseline ? "yes" : "no"}\n`;
              text += `- Introduced: ${normalized.counts.introducedTotal} (critical=${normalized.counts.critical}, high=${normalized.counts.high}, medium=${normalized.counts.medium}, low=${normalized.counts.low})\n`;
              if (normalized.tool === "sonarqube") {
                text += `- Sonar Metrics: bugs=${normalized.counts.bugs}, codeSmells=${normalized.counts.codeSmells}, complexityDelta=${normalized.counts.complexityDelta}\n`;
              }
              if (normalized.issues.length > 0) {
                text += `- Top Issues:\n`;
                for (const issue of normalized.issues.slice(0, 20)) {
                  const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : "(no file)";
                  text += `  - [${issue.severity.toUpperCase()}${issue.isBlocking ? ", BLOCKING" : ""}] ${location} — ${issue.message}\n`;
                }
                if (normalized.truncated) text += "  - ... additional normalized issues omitted\n";
              }
              text += "\n";
            }
          }
        }

        const hiddenMechanisms = Array.isArray(feedback.hiddenFailureMechanisms) &&
          feedback.hiddenFailureMechanisms.length > 0
          ? feedback.hiddenFailureMechanisms
          : (Array.isArray(result.hiddenFailureMechanisms) ? result.hiddenFailureMechanisms : []);

        if (hiddenMechanisms.length > 0) {
          text += `\n## Hidden Failure Mechanisms (safe summary)\n\n`;
          for (const mechanism of hiddenMechanisms.slice(0, 10)) {
            const label = typeof mechanism?.label === "string" ? mechanism.label : "Unknown edge case";
            const count = typeof mechanism?.count === "number" ? mechanism.count : "?";
            const guidance = typeof mechanism?.guidance === "string"
              ? mechanism.guidance
              : "Harden boundary conditions and error handling.";
            text += `- **${label}** (${count}): ${guidance}\n`;
          }
        }

        return { content: [{ type: "text" as const, text }] };
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
