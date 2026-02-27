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
    mode?: string;
    workspaceStatus?: string;
    workerHost?: string | null;
    workspaceError?: string | null;
    vmBootStage?: string | null;
    firecrackerExitCode?: number | null;
    firecrackerStderrTail?: string | null;
    rootfsAccessCheck?: string | null;
    expiresAt?: number | null;
    workerHealth?: {
      reachable?: boolean;
      httpStatus?: number;
      status?: string;
      checks?: Record<string, string>;
      error?: string;
    } | null;
  };
}

export function registerWorkspaceStartupLog(server: McpServer): void {
  registerTool(
    server,
    "workspace_startup_log",
    "Fetch workspace startup diagnostics (shared worker + Firecracker execution environment health) for a claimed bounty workspace.",
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
        const checks = startup?.workerHealth?.checks
          ? Object.entries(startup.workerHealth.checks).map(([k, v]) => `- ${k}: ${v}`)
          : [];
        const lines = [
          "# Workspace Startup Diagnostics",
          "",
          `- Bounty: ${result.bountyId ?? args.bountyId ?? "unknown"}`,
          `- Claim: ${result.claimId ?? args.claimId ?? "unknown"}`,
          `- Workspace: ${result.workspaceId ?? args.workspaceId ?? "unknown"}`,
          `- Mode: ${startup?.mode ?? "shared_worker"}`,
          `- Workspace status: ${startup?.workspaceStatus ?? "unknown"}`,
          startup?.workerHost ? `- Worker host: ${startup.workerHost}` : null,
          startup?.workspaceError ? `- Workspace error: ${startup.workspaceError}` : null,
          startup?.vmBootStage ? `- VM boot stage: ${startup.vmBootStage}` : null,
          startup?.firecrackerExitCode !== undefined && startup?.firecrackerExitCode !== null
            ? `- Firecracker exit code: ${startup.firecrackerExitCode}`
            : null,
          startup?.rootfsAccessCheck ? `- Rootfs access check: ${startup.rootfsAccessCheck}` : null,
          startup?.firecrackerStderrTail
            ? `- Firecracker stderr tail: ${startup.firecrackerStderrTail}`
            : null,
          startup?.workerHealth
            ? `- Worker reachable: ${startup.workerHealth.reachable ? "yes" : "no"}`
            : null,
          startup?.workerHealth?.httpStatus !== undefined
            ? `- Worker health HTTP: ${startup.workerHealth.httpStatus}`
            : null,
          startup?.workerHealth?.status ? `- Worker health status: ${startup.workerHealth.status}` : null,
          startup?.workerHealth?.error ? `- Worker health error: ${startup.workerHealth.error}` : null,
          startup?.expiresAt ? `- Workspace expires at: ${new Date(startup.expiresAt).toISOString()}` : null,
          "",
          "## Worker Health Checks",
          "",
          checks.length > 0 ? checks.join("\n") : "No worker health checks captured yet.",
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
