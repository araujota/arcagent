import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

interface FeedbackResponse {
  feedbackJson: string | null;
  verificationStatus: string;
  attemptNumber?: number;
}

export function registerGetSubmissionFeedback(server: McpServer): void {
  registerTool(
    server,
    "get_submission_feedback",
    "Get structured feedback from the most recent failed verification for a bounty. Returns prioritized action items, per-file issues, remaining attempts, public test output, and hidden-test summary-safe guidance.",
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
          const publicTests = feedback.testResults.filter(
            (t: { visibility?: string }) => (t.visibility ?? "public") === "public",
          );
          const failed = publicTests.filter((t: { status: string }) => t.status === "fail");
          const passed = publicTests.filter((t: { status: string }) => t.status === "pass");
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
          const safeItems = feedback.actionItems.filter(
            (item: string) => !item.toLowerCase().includes("hidden"),
          );
          text += `\n## Action Items (prioritized — fix in this order)\n\n`;
          for (let i = 0; i < safeItems.length; i++) {
            text += `${i + 1}. ${safeItems[i]}\n`;
          }
        }

        if (Array.isArray(feedback.hiddenFailureMechanisms) && feedback.hiddenFailureMechanisms.length > 0) {
          text += `\n## Hidden Failure Mechanisms (safe summary)\n\n`;
          for (const mechanism of feedback.hiddenFailureMechanisms.slice(0, 10)) {
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
