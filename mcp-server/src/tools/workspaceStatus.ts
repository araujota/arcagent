import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent, invalidateWorkspaceCache } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";
import { isMissingWorkspaceSessionError, staleWorkspaceSessionMessage } from "../workspace/workerErrors";

const WORKSPACE_GETTING_STARTED_TEXT =
  "# Getting Started\n\n" +
  "1. `list_bounties` — Browse available bounties\n" +
  "2. `get_bounty_details` — Read requirements + Gherkin specs\n" +
  "3. `claim_bounty` — Claim a bounty (workspace provisioned automatically)\n" +
  "4. `workspace_status` — Check when workspace is ready (~30-90s)\n" +
  "5. `workspace_exec`, `workspace_read_file`, `workspace_write_file` — Develop\n" +
  "6. `submit_solution` — Submit for verification\n" +
  "7. `get_verification_status` — Check results\n\n" +
  "Provide a `bountyId` to check a specific workspace.";

interface WorkspaceStatusView {
  displayStatus: string;
  workerSessionAvailable: boolean;
  availabilityWarning: string | null;
}

function renderWorkspaceNotFound(ws: {
  reason?: string;
  message?: string;
  claimId?: string;
}): string {
  const lines: string[] = ["No workspace is currently available for this bounty."];
  if (ws.reason === "no_active_claim") {
    lines.push("Use `claim_bounty` to claim the bounty — a workspace will be provisioned automatically.");
    return lines.join("\n\n");
  }

  if (ws.claimId) {
    lines.push(`Active claim detected: \`${ws.claimId}\`.`);
  }
  if (ws.reason === "workspace_provision_failed" && ws.message) {
    lines.push(`Provisioning error: ${ws.message}`);
  } else {
    lines.push("If you just claimed this bounty, workspace provisioning has been (re)triggered.");
  }
  lines.push("Check again in 10-20 seconds with `workspace_status`.");
  lines.push("If you stop working this bounty, release the claim with `release_claim` so capacity is freed.");
  return lines.join("\n\n");
}

function appendRemainingTime(parts: string[], expiresAt: number): void {
  const remaining = expiresAt - Date.now();
  if (remaining > 0) {
    const mins = Math.floor(remaining / 60000);
    const hours = Math.floor(mins / 60);
    parts.push(`- **Time remaining:** ${hours}h ${mins % 60}m`);
    return;
  }
  parts.push("- **Status:** Expired");
}

async function getWorkspaceStatusView(args: {
  ws: {
    status: string;
    workerHost: string;
    workspaceId: string;
  };
  userId: string;
  bountyId: string;
}): Promise<WorkspaceStatusView> {
  let displayStatus = args.ws.status;
  let workerSessionAvailable = args.ws.status === "ready";
  let availabilityWarning: string | null = null;

  if (args.ws.status !== "ready") {
    return { displayStatus, workerSessionAvailable, availabilityWarning };
  }

  try {
    const live = await callWorker<{ status: string }>(
      args.ws.workerHost,
      "/api/workspace/status",
      { workspaceId: args.ws.workspaceId },
      8_000,
    );
    if (live.status !== "ready") {
      workerSessionAvailable = false;
      displayStatus = `ready (worker reports ${live.status})`;
      invalidateWorkspaceCache(args.userId, args.bountyId);
      availabilityWarning =
        `Worker reports this workspace as \`${live.status}\`, so interactive commands may fail.\n\n` +
        "Control-plane cache was invalidated and will refresh on next lookup.";
    }
  } catch (err) {
    if (isMissingWorkspaceSessionError(err)) {
      workerSessionAvailable = false;
      displayStatus = "ready (stale)";
      invalidateWorkspaceCache(args.userId, args.bountyId);
      availabilityWarning = staleWorkspaceSessionMessage();
    }
  }

  return { displayStatus, workerSessionAvailable, availabilityWarning };
}

async function appendDirectoryTree(args: {
  parts: string[];
  showTree?: string;
  workerSessionAvailable: boolean;
  ws: {
    workerHost: string;
    workspaceId: string;
  };
}): Promise<void> {
  if (args.showTree !== "true") {
    return;
  }
  if (!args.workerSessionAvailable) {
    args.parts.push("\n*(Directory listing skipped because worker session is currently unavailable)*");
    return;
  }

  try {
    const treeResult = await callWorker<{
      stdout: string;
      exitCode: number;
    }>(args.ws.workerHost, "/api/workspace/exec", {
      workspaceId: args.ws.workspaceId,
      command:
        "find /workspace -maxdepth 2 -not -path '*/node_modules/*' -not -path '*/.git/*' | head -80",
      timeoutMs: 10000,
    });

    if (!treeResult.stdout) {
      return;
    }
    args.parts.push("\n### Directory Structure\n```", treeResult.stdout.trim(), "```");
  } catch {
    args.parts.push("\n*(Could not fetch directory listing)*");
  }
}

function appendAvailableCommands(parts: string[], workerSessionAvailable: boolean): void {
  parts.push("\n### Available Commands");
  if (workerSessionAvailable) {
    parts.push("- `workspace_exec` — Run shell commands");
    parts.push("- `workspace_read_file` — Read source files");
    parts.push("- `workspace_write_file` — Write/create files");
    parts.push("- `submit_solution` — Submit changes for verification");
    return;
  }
  parts.push("- Worker session is unavailable; commands will fail until workspace is reprovisioned.");
  parts.push("- Use `workspace_startup_log` for diagnostics.");
}

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
              text: WORKSPACE_GETTING_STARTED_TEXT,
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
              text: renderWorkspaceNotFound(ws),
              },
            ],
          };
      }

      const statusView = await getWorkspaceStatusView({
        ws,
        userId: user.userId,
        bountyId: args.bountyId,
      });

      const parts: string[] = [];
      parts.push(`## Workspace Status: **${statusView.displayStatus}**`);
      parts.push(`- **Workspace ID:** ${ws.workspaceId}`);
      appendRemainingTime(parts, ws.expiresAt);

      if (ws.status === "provisioning") {
        parts.push(
          "\nWorkspace is being set up. Check again in 15-30 seconds.",
        );
        parts.push("\nIf you abandon this bounty, run `release_claim` to free the reserved slot.");
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
        };
      }

      if (ws.status !== "ready") {
        parts.push(`\nWorkspace is in status: ${ws.status}`);
        if (ws.status === "error" && ws.errorMessage) {
          parts.push(`- **Last error:** ${ws.errorMessage}`);
        }
        parts.push("\nIf you stop work on this bounty, run `release_claim` to return capacity to the worker pool.");
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
        };
      }

      if (statusView.availabilityWarning) {
        parts.push("\n### Availability Warning", statusView.availabilityWarning);
      }

      await appendDirectoryTree({
        parts,
        showTree: args.showTree,
        workerSessionAvailable: statusView.workerSessionAvailable,
        ws,
      });
      appendAvailableCommands(parts, statusView.workerSessionAvailable);

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
      };
    },
  );
}
