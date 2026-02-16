import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

export function registerWorkspaceStatus(server: McpServer): void {
  registerTool(
    server,
    "workspace_status",
    "Check workspace readiness, time remaining, and resource usage.",
    {
      bountyId: z
        .string()
        .optional()
        .describe("Bounty ID (optional if you only have one active claim)"),
      showTree: z
        .string()
        .optional()
        .describe("Set to 'true' to show top-level directory listing"),
    },
    async (args) => {
      requireScope("workspace:read");
      const user = requireAuthUser();

      if (!args.bountyId) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "# Getting Started\n\n" +
                "1. `list_bounties` — Browse available bounties\n" +
                "2. `get_bounty_details` — Read requirements + Gherkin specs\n" +
                "3. `claim_bounty` — Claim a bounty (workspace provisioned automatically)\n" +
                "4. `workspace_status` — Check when workspace is ready (~30-90s)\n" +
                "5. `workspace_exec`, `workspace_read_file`, `workspace_write_file` — Develop\n" +
                "6. `submit_solution` — Submit for verification\n" +
                "7. `get_verification_status` — Check results\n\n" +
                "Provide a `bountyId` to check a specific workspace.",
            },
          ],
        };
      }

      const ws = await getWorkspaceForAgent(user.userId, args.bountyId);
      if (!ws.found) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No workspace found for this bounty.\n\n" +
                "Use `claim_bounty` to claim the bounty — a workspace will be provisioned automatically.\n" +
                "Then use `workspace_status` to check when it's ready (~30-90 seconds).",
            },
          ],
        };
      }

      const parts: string[] = [];
      parts.push(`## Workspace Status: **${ws.status}**`);
      parts.push(`- **Workspace ID:** ${ws.workspaceId}`);

      const remaining = ws.expiresAt - Date.now();
      if (remaining > 0) {
        const mins = Math.floor(remaining / 60000);
        const hours = Math.floor(mins / 60);
        parts.push(
          `- **Time remaining:** ${hours}h ${mins % 60}m`,
        );
      } else {
        parts.push("- **Status:** Expired");
      }

      if (ws.status === "provisioning") {
        parts.push(
          "\nWorkspace is being set up. Check again in 15-30 seconds.",
        );
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
        };
      }

      if (ws.status !== "ready") {
        parts.push(`\nWorkspace is in status: ${ws.status}`);
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
        };
      }

      // Show directory tree if requested
      if (args.showTree === "true") {
        try {
          const treeResult = await callWorker<{
            stdout: string;
            exitCode: number;
          }>(ws.workerHost, "/api/workspace/exec", {
            workspaceId: ws.workspaceId,
            command:
              "find /workspace -maxdepth 2 -not -path '*/node_modules/*' -not -path '*/.git/*' | head -80",
            timeoutMs: 10000,
          });

          if (treeResult.stdout) {
            parts.push("\n### Directory Structure\n```");
            parts.push(treeResult.stdout.trim());
            parts.push("```");
          }
        } catch {
          parts.push("\n*(Could not fetch directory listing)*");
        }
      }

      parts.push("\n### Available Commands");
      parts.push("- `workspace_exec` — Run shell commands");
      parts.push("- `workspace_read_file` — Read source files");
      parts.push("- `workspace_write_file` — Write/create files");
      parts.push("- `submit_solution` — Submit changes for verification");

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
      };
    },
  );
}
