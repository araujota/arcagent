import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { registerTool } from "../lib/toolHelper";
import { getWorkspaceForAgent } from "../workspace/cache";

const HEALTH_TIMEOUT_MS = 10_000;

export function registerCheckWorkerStatus(server: McpServer): void {
  registerTool(
    server,
    "check_worker_status",
    "Ping the worker health endpoint for a claimed bounty workspace.",
    {
      bountyId: z
        .string()
        .optional()
        .describe("Bounty ID (required to resolve the workspace worker host)"),
    },
    async (args: { bountyId?: string }) => {
      requireScope("workspace:read");
      const user = requireAuthUser();

      if (!args.bountyId) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Provide a `bountyId` to check worker health for that workspace.\n\n" +
                "Use `workspace_status` first if you need to confirm the workspace is provisioned.",
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
                "Claim the bounty first with `claim_bounty`, then retry `check_worker_status`.",
            },
          ],
          isError: true,
        };
      }

      const baseUrl = ws.workerHost.replace(/\/+$/, "");
      const url = `${baseUrl}/api/health`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: "GET",
          signal: controller.signal,
        });

        clearTimeout(timer);

        const body = await response.json().catch(() => null) as
          | { status?: string; checks?: Record<string, string>; timestamp?: string }
          | null;

        const healthStatus = body?.status ?? "unknown";
        const checks = body?.checks ? Object.entries(body.checks) : [];
        const checksText = checks.length > 0
          ? checks.map(([key, value]) => `- ${key}: ${value}`).join("\n")
          : "- checks unavailable";

        const text =
          `Worker health for ${baseUrl}\n` +
          `- HTTP status: ${response.status}\n` +
          `- Health status: ${healthStatus}\n` +
          (body?.timestamp ? `- Timestamp: ${body.timestamp}\n` : "") +
          "\nChecks:\n" +
          checksText;

        return {
          content: [{ type: "text" as const, text }],
          isError: !response.ok,
        };
      } catch (err) {
        clearTimeout(timer);
        const message = err instanceof Error ? err.message : "Health check failed";
        return {
          content: [{ type: "text" as const, text: `Worker health check failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
