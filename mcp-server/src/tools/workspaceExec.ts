import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

export function registerWorkspaceExec(server: McpServer): void {
  registerTool(
    server,
    "workspace_exec",
    "Run a shell command in your development workspace. The repository is at /workspace. " +
      "Commands run as non-root user. Use for building, testing, installing packages, running scripts.",
    {
      bountyId: z.string().describe("The bounty ID you have claimed"),
      command: z.string().describe("Shell command to execute"),
      timeoutMs: z
        .string()
        .optional()
        .describe("Timeout in ms (default 120000, max 300000)"),
    },
    async (args) => {
      requireScope("workspace:exec");
      const user = requireAuthUser();

      const ws = await getWorkspaceForAgent(user.userId, args.bountyId);
      if (!ws.found || ws.status !== "ready") {
        return {
          content: [
            {
              type: "text" as const,
              text: ws.found
                ? `Workspace is not ready (status: ${ws.status}). Use \`workspace_status\` to check.`
                : "No workspace found for this bounty. Claim the bounty first with `claim_bounty`.",
            },
          ],
          isError: true,
        };
      }

      try {
        const timeout = args.timeoutMs
          ? Math.min(parseInt(args.timeoutMs, 10), 300000)
          : 120000;

        const result = await callWorker<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>(ws.workerHost, "/api/workspace/exec", {
          workspaceId: ws.workspaceId,
          command: args.command,
          timeoutMs: timeout,
        }, timeout + 10_000);

        const parts: string[] = [];
        if (result.stdout) {
          parts.push("**stdout:**\n```\n" + result.stdout + "\n```");
        }
        if (result.stderr) {
          parts.push("**stderr:**\n```\n" + result.stderr + "\n```");
        }
        parts.push(`**exit code:** ${result.exitCode}`);

        return {
          content: [{ type: "text" as const, text: parts.join("\n\n") }],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Command execution failed";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
