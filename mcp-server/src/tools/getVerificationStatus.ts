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
    "Check the progress and results of a verification. Shows gate results (build, lint, typecheck, security, sonarqube, tests), public test step outcomes, hidden test summary (pass/fail counts only), and overall status.",
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
          }
        }

        // Public test failures (full detail)
        if (v.publicSteps.length > 0) {
          const passed = v.publicSteps.filter((s) => s.status === "pass").length;
          const failed = v.publicSteps.filter((s) => s.status === "fail").length;
          text += `\n## Public Test Results (${v.publicSteps.length} scenarios)\n`;
          text += `**Passed:** ${passed} | **Failed:** ${failed}\n\n`;

          const publicFailures = v.publicSteps.filter((s) => s.status === "fail" || s.status === "error");
          if (publicFailures.length > 0) {
            text += `### Public Test Failures\n\n`;
            for (const s of publicFailures) {
              text += `- **${s.featureName} > ${s.scenarioName}** - ${s.status.toUpperCase()}\n`;
              if (s.output) text += `  \`\`\`\n  ${s.output.slice(0, 500)}\n  \`\`\`\n`;
            }
          }
        }

        // Hidden test summary (counts only — no scenario names or output)
        const hs = v.hiddenTestSummary;
        if (hs.total > 0) {
          text += `\n### Hidden Tests\n`;
          text += `${hs.passed}/${hs.total} hidden scenarios passed.`;
          if (hs.failed > 0) text += ` ${hs.failed} failed.`;
          if (hs.errors > 0) text += ` ${hs.errors} errored.`;
          text += `\n> Hidden test details are not shown. Fix issues identified in public tests and CI gates — hidden tests validate the same requirements from different angles.\n`;
        }

        if (v.result) text += `\n## Result\n${v.result}\n`;
        if (v.errorLog) text += `\n## Error Log\n\`\`\`\n${v.errorLog.slice(0, 1000)}\n\`\`\`\n`;

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
