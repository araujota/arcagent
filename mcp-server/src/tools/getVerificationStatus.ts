import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { ConvexAgentVerification } from "../lib/types";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

export function registerGetVerificationStatus(server: McpServer): void {
  registerTool(
    server,
    "get_verification_status",
    "Check verification progress and results. Shows gate results (build, lint, typecheck, security, tests), verbose test output for ALL scenarios (public + hidden), full lint/type/security diagnostics, and structured feedback with prioritized action items.",
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

        const v = result.verification;

        let text = `# Verification Status\n\n`;
        text += `**ID:** ${v._id}\n`;
        text += `**Overall Status:** ${v.status}\n`;
        if (v.startedAt) text += `**Started:** ${new Date(v.startedAt).toISOString()}\n`;
        if (v.completedAt) text += `**Completed:** ${new Date(v.completedAt).toISOString()}\n`;

        if (v.job) {
          text += `\n## Worker Job\n`;
          text += `**Job Status:** ${v.job.status}\n`;
          if (v.job.currentGate) text += `**Current Gate:** ${v.job.currentGate}\n`;
        }

        if (v.gates.length > 0) {
          text += `\n## Gate Results\n\n`;
          text += `| Gate | Status | Tool |\n|------|--------|------|\n`;
          for (const g of v.gates) {
            const statusLabel = g.status === "passed" ? "PASS" : g.status === "failed" ? "FAIL" : "WARN";
            text += `| ${g.gateType} | ${statusLabel} | ${g.tool} |\n`;
            // Show full gate issues (lint violations, type errors, security findings)
            if (g.issues && g.issues.length > 0) {
              text += `\n**${g.gateType} issues:**\n`;
              for (const issue of g.issues.slice(0, 50)) {
                text += `- ${issue}\n`;
              }
              if (g.issues.length > 50) {
                text += `- ... and ${g.issues.length - 50} more\n`;
              }
              text += `\n`;
            }
          }
        }

        // ALL test results with verbose output (public + hidden)
        const steps = v.steps ?? [];
        if (steps.length > 0) {
          const passed = steps.filter((s: { status: string }) => s.status === "pass").length;
          const failed = steps.filter((s: { status: string }) => s.status === "fail").length;
          text += `\n## Test Results (${steps.length} scenarios)\n`;
          text += `**Passed:** ${passed} | **Failed:** ${failed}\n\n`;

          const failures = steps.filter((s: { status: string }) => s.status === "fail" || s.status === "error");
          if (failures.length > 0) {
            text += `### Failed Scenarios\n\n`;
            for (const s of failures) {
              text += `- **${s.featureName} > ${s.scenarioName}** [${s.visibility}] - ${s.status.toUpperCase()}\n`;
              if (s.output) text += `  \`\`\`\n${s.output}\n  \`\`\`\n`;
            }
          }
        }

        // Structured feedback with prioritized action items
        if (v.feedbackJson) {
          try {
            const feedback = JSON.parse(v.feedbackJson);
            text += `\n## Structured Feedback\n\n`;
            text += `**Attempt:** ${feedback.attemptNumber ?? "?"} | **Remaining:** ${feedback.attemptsRemaining ?? "?"}\n\n`;
            if (feedback.actionItems && feedback.actionItems.length > 0) {
              text += `### Action Items (prioritized)\n\n`;
              for (let i = 0; i < feedback.actionItems.length; i++) {
                text += `${i + 1}. ${feedback.actionItems[i]}\n`;
              }
            }
          } catch {
            // feedbackJson parse failed — skip
          }
        }

        if (v.result) text += `\n## Result\n${v.result}\n`;
        if (v.errorLog) text += `\n## Error Log\n\`\`\`\n${v.errorLog.slice(0, 2000)}\n\`\`\`\n`;

        return { content: [{ type: "text" as const, text }] };
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
