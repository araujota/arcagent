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

function missingIdentifierResponse() {
  return {
    content: [{
      type: "text" as const,
      text: "Provide one of `bountyId`, `workspaceId`, or `claimId`.",
    }],
    isError: true,
  };
}

function formatWorkerHealthChecks(startup: StartupLogResponse["startupLog"]): string {
  if (!startup?.workerHealth?.checks) {
    return "No worker health checks captured yet.";
  }
  const checks = Object.entries(startup.workerHealth.checks).map(([key, value]) => `- ${key}: ${value}`);
  return checks.length > 0 ? checks.join("\n") : "No worker health checks captured yet.";
}

function buildStartupDiagnostics(result: StartupLogResponse, args: {
  bountyId?: string;
  workspaceId?: string;
  claimId?: string;
}): string {
  const startup = result.startupLog;
  const lines: string[] = [
    "# Workspace Startup Diagnostics",
    "",
    `- Bounty: ${result.bountyId ?? args.bountyId ?? "unknown"}`,
    `- Claim: ${result.claimId ?? args.claimId ?? "unknown"}`,
    `- Workspace: ${result.workspaceId ?? args.workspaceId ?? "unknown"}`,
    `- Mode: ${startup?.mode ?? "shared_worker"}`,
    `- Workspace status: ${startup?.workspaceStatus ?? "unknown"}`,
  ];

  if (startup?.workerHost) {
    lines.push(`- Worker host: ${startup.workerHost}`);
  }
  if (startup?.workspaceError) {
    lines.push(`- Workspace error: ${startup.workspaceError}`);
  }
  if (startup?.vmBootStage) {
    lines.push(`- VM boot stage: ${startup.vmBootStage}`);
  }
  if (startup?.firecrackerExitCode !== undefined && startup.firecrackerExitCode !== null) {
    lines.push(`- Firecracker exit code: ${startup.firecrackerExitCode}`);
  }
  if (startup?.rootfsAccessCheck) {
    lines.push(`- Rootfs access check: ${startup.rootfsAccessCheck}`);
  }
  if (startup?.firecrackerStderrTail) {
    lines.push(`- Firecracker stderr tail: ${startup.firecrackerStderrTail}`);
  }
  if (startup?.workerHealth) {
    lines.push(`- Worker reachable: ${startup.workerHealth.reachable ? "yes" : "no"}`);
  }
  if (startup?.workerHealth?.httpStatus !== undefined) {
    lines.push(`- Worker health HTTP: ${startup.workerHealth.httpStatus}`);
  }
  if (startup?.workerHealth?.status) {
    lines.push(`- Worker health status: ${startup.workerHealth.status}`);
  }
  if (startup?.workerHealth?.error) {
    lines.push(`- Worker health error: ${startup.workerHealth.error}`);
  }
  if (startup?.expiresAt) {
    lines.push(`- Workspace expires at: ${new Date(startup.expiresAt).toISOString()}`);
  }

  lines.push("", "## Worker Health Checks", "", formatWorkerHealthChecks(startup));
  return lines.join("\n");
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
        return missingIdentifierResponse();
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
        return { content: [{ type: "text" as const, text: buildStartupDiagnostics(result, args) }] };
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
