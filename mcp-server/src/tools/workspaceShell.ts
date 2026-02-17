import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

export function registerWorkspaceShell(server: McpServer): void {
  registerTool(
    server,
    "workspace_shell",
    "Run a command in a persistent shell session. Unlike workspace_exec which starts a fresh shell for " +
      "each command, this maintains state (cwd, env vars, shell history) across calls within the same session. " +
      "Use sessionId to manage multiple parallel sessions (e.g. one for building, one for testing). " +
      "The repository is at /workspace.",
    {
      bountyId: z.string().describe("The bounty ID you have claimed"),
      command: z.string().describe("Shell command to execute"),
      sessionId: z
        .string()
        .optional()
        .describe("Session identifier for persistent state (default 'default')"),
    },
    async (args) => {
      // SECURITY (H4): Scope enforcement
      requireScope("workspace:exec");
      // SECURITY (C1): Identity from auth context
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
        const result = await callWorker<{
          stdout: string;
          exitCode: number;
          cwd: string;
        }>(ws.workerHost, "/api/workspace/session-exec", {
          workspaceId: ws.workspaceId,
          command: args.command,
          sessionId: args.sessionId ?? "default",
        });

        const parts: string[] = [];
        if (result.stdout) {
          parts.push("**stdout:**\n```\n" + result.stdout + "\n```");
        }
        parts.push(`**exit code:** ${result.exitCode}`);
        parts.push(`**cwd:** ${result.cwd}`);

        return {
          content: [{ type: "text" as const, text: parts.join("\n\n") }],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Shell command execution failed";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
