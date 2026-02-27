import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { requireAuthUser, requireScope } from "../lib/context";
import { registerTool } from "../lib/toolHelper";

interface StartupLogResponse {
  found: boolean;
  message?: string;
  workspaceId?: string;
  claimId?: string;
  bountyId?: string;
  startupLog?: {
    found?: boolean;
    message?: string;
    log?: string;
    status?: string;
    bootLogRef?: string | null;
    instanceId?: string;
    publicHost?: string | null;
    launchRequestedAt?: number | null;
    runningAt?: number | null;
    healthyAt?: number | null;
    terminatedAt?: number | null;
    errorMessage?: string | null;
  };
}

export function registerWorkspaceStartupLog(server: McpServer): void {
  registerTool(
    server,
    "workspace_startup_log",
    "Fetch dedicated attempt-worker startup diagnostics (EC2 + worker bootstrap) for a claimed bounty workspace.",
    {
      bountyId: z.string().optional().describe("Bounty ID (recommended for agent usage)"),
      workspaceId: z.string().optional().describe("Workspace ID (optional operator override)"),
      claimId: z.string().optional().describe("Claim ID (optional operator override)"),
    },
    async (args: { bountyId?: string; workspaceId?: string; claimId?: string }) => {
      requireScope("workspace:read");
      requireAuthUser();

      if (!args.bountyId && !args.workspaceId && !args.claimId) {
        return {
          content: [{
            type: "text" as const,
            text: "Provide one of `bountyId`, `workspaceId`, or `claimId`.",
          }],
          isError: true,
        };
      }

      try {
        const result = await callConvex<StartupLogResponse>(
          "/api/mcp/workspace/startup-log",
          {
            bountyId: args.bountyId,
            workspaceId: args.workspaceId,
            claimId: args.claimId,
          },
        );

        if (!result.found) {
          return {
            content: [{ type: "text" as const, text: result.message ?? "Startup log not available." }],
            isError: true,
          };
        }

        const startup = result.startupLog;
        const lines = [
          "# Workspace Startup Diagnostics",
          "",
          `- Bounty: ${result.bountyId ?? args.bountyId ?? "unknown"}`,
          `- Claim: ${result.claimId ?? args.claimId ?? "unknown"}`,
          `- Workspace: ${result.workspaceId ?? args.workspaceId ?? "unknown"}`,
          `- Status: ${startup?.status ?? startup?.message ?? "unknown"}`,
          startup?.instanceId ? `- Instance: ${startup.instanceId}` : null,
          startup?.publicHost ? `- Worker host: ${startup.publicHost}` : null,
          startup?.bootLogRef ? `- Boot log ref: ${startup.bootLogRef}` : null,
          startup?.errorMessage ? `- Error: ${startup.errorMessage}` : null,
          "",
          "## Boot Log",
          "",
          startup?.log && startup.log.trim().length > 0
            ? "```\n" + startup.log + "\n```"
            : "No boot log captured yet.",
        ].filter(Boolean);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to fetch startup log";
        return {
          content: [{ type: "text" as const, text: `Failed to fetch startup log: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
