import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent, invalidateWorkspaceCache } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";
import { isMissingWorkspaceSessionError, staleWorkspaceSessionMessage } from "../workspace/workerErrors";

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
        const lines: string[] = ["No workspace is currently available for this bounty."];
        if (ws.reason === "no_active_claim") {
          lines.push(
            "Use `claim_bounty` to claim the bounty — a workspace will be provisioned automatically.",
          );
        } else {
          if (ws.claimId) {
            lines.push(`Active claim detected: \`${ws.claimId}\`.`);
          }
          if (ws.reason === "workspace_provision_failed" && ws.message) {
            lines.push(`Provisioning error: ${ws.message}`);
          } else {
            lines.push("If you just claimed this bounty, workspace provisioning has been (re)triggered.");
          }
          lines.push("Check again in 10-20 seconds with `workspace_status`.");
        }
        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n\n"),
            },
          ],
        };
      }

      let displayStatus = ws.status;
      let workerSessionAvailable = ws.status === "ready";
      let availabilityWarning: string | null = null;

      if (ws.status === "ready") {
        try {
          const live = await callWorker<{ status: string }>(
            ws.workerHost,
            "/api/workspace/status",
            { workspaceId: ws.workspaceId },
            8_000,
          );
          if (live.status !== "ready") {
            workerSessionAvailable = false;
            displayStatus = `ready (worker reports ${live.status})`;
            invalidateWorkspaceCache(user.userId, args.bountyId);
            availabilityWarning =
              `Worker reports this workspace as \`${live.status}\`, so interactive commands may fail.\n\n` +
              "Control-plane cache was invalidated and will refresh on next lookup.";
          }
        } catch (err) {
          if (isMissingWorkspaceSessionError(err)) {
            workerSessionAvailable = false;
            displayStatus = "ready (stale)";
            invalidateWorkspaceCache(user.userId, args.bountyId);
            availabilityWarning = staleWorkspaceSessionMessage();
          }
        }
      }

      const parts: string[] = [];
      parts.push(`## Workspace Status: **${displayStatus}**`);
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
        if (ws.status === "error" && ws.errorMessage) {
          parts.push(`- **Last error:** ${ws.errorMessage}`);
        }
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
        };
      }

      if (availabilityWarning) {
        parts.push("\n### Availability Warning");
        parts.push(availabilityWarning);
      }

      // Show directory tree if requested
      if (args.showTree === "true" && workerSessionAvailable) {
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
      } else if (args.showTree === "true") {
        parts.push("\n*(Directory listing skipped because worker session is currently unavailable)*");
      }

      parts.push("\n### Available Commands");
      if (workerSessionAvailable) {
        parts.push("- `workspace_exec` — Run shell commands");
        parts.push("- `workspace_read_file` — Read source files");
        parts.push("- `workspace_write_file` — Write/create files");
        parts.push("- `submit_solution` — Submit changes for verification");
      } else {
        parts.push("- Worker session is unavailable; commands will fail until workspace is reprovisioned.");
        parts.push("- Use `workspace_startup_log` for diagnostics.");
      }

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
      };
    },
  );
}
