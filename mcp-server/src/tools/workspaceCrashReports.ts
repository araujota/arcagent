import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";

interface CrashReport {
  _id: string;
  workspaceId: string;
  exitCode: number;
  signal?: string;
  command?: string;
  stderr?: string;
  timestamp: number;
  gate?: string;
}

function formatReportCountLabel(count: number): string {
  return `**${count} crash report${count > 1 ? "s" : ""} found:**\n`;
}

function formatReportStderr(stderr: string): string {
  if (stderr.length <= 2000) return stderr;
  return `${stderr.slice(-2000)}\n... [truncated]`;
}

function formatCrashReport(report: CrashReport): string {
  const timestamp = new Date(report.timestamp).toISOString();
  const lines: string[] = [`### Crash at ${timestamp}`];

  if (report.command) {
    lines.push(`- **Command:** \`${report.command}\``);
  }
  if (report.gate) {
    lines.push(`- **Gate:** ${report.gate}`);
  }
  lines.push(`- **Exit code:** ${report.exitCode}`);
  if (report.signal) {
    lines.push(`- **Signal:** ${report.signal}`);
  }
  if (report.stderr) {
    lines.push(`- **stderr:**\n\`\`\`\n${formatReportStderr(report.stderr)}\n\`\`\``);
  }

  return lines.join("\n");
}

export function registerWorkspaceCrashReports(server: McpServer): void {
  registerTool(
    server,
    "workspace_crash_reports",
    "Retrieve crash reports for your workspace. Shows commands that failed with non-zero exit codes " +
      "or signals during verification or development. Useful for debugging build failures, test crashes, " +
      "and OOM kills.",
    {
      bountyId: z.string().describe("The bounty ID you have claimed"),
    },
    async (args) => {
      // SECURITY (H4): Scope enforcement
      requireScope("workspace:read");
      // SECURITY (C1): Identity from auth context
      const user = requireAuthUser();

      try {
        const result = await callConvex<{
          reports: CrashReport[];
        }>("/api/mcp/workspace/crash-reports", {
          bountyId: args.bountyId,
          userId: user.userId,
        });

        const reports = result.reports ?? [];
        if (reports.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No crash reports found for this workspace.",
              },
            ],
          };
        }

        const body = reports.map(formatCrashReport).join("\n\n---\n\n");
        const text = `${formatReportCountLabel(reports.length)}\n${body}`;

        return {
          content: [
            {
              type: "text" as const,
              text,
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fetch crash reports";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
