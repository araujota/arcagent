import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { registerTool } from "../lib/toolHelper";

const HEALTH_TIMEOUT_MS = 10_000;
const DEFAULT_WORKER_BASE_URL = "http://worker.speedlesvc.com:3001";

function resolveWorkerBaseUrl(override?: string): string | null {
  const candidates = [
    override,
    process.env.WORKER_HEALTH_URL,
    process.env.WORKER_API_URL,
    DEFAULT_WORKER_BASE_URL,
  ];

  for (const candidate of candidates) {
    const raw = candidate?.trim();
    if (!raw) continue;
    if (!/^https?:\/\//i.test(raw)) continue;
    return raw.replace(/\/+$/, "");
  }

  return null;
}

export function registerWorkerHealth(server: McpServer): void {
  registerTool(
    server,
    "worker_health",
    "Check the default worker health endpoint without requiring an active bounty claim.",
    {
      workerHost: z
        .string()
        .optional()
        .describe("Optional worker host override (for example https://worker.example.com:3001)"),
    },
    async (args: { workerHost?: string }) => {
      requireScope("workspace:read");
      requireAuthUser();

      const baseUrl = resolveWorkerBaseUrl(args.workerHost);
      if (!baseUrl) {
        return {
          content: [{
            type: "text" as const,
            text:
              "Worker URL is not configured.\n\n" +
              "Set `WORKER_HEALTH_URL` or `WORKER_API_URL`, or pass `workerHost`.",
          }],
          isError: true,
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

      try {
        const response = await fetch(`${baseUrl}/api/health`, {
          method: "GET",
          signal: controller.signal,
        });
        clearTimeout(timer);

        const body = await response.json().catch(() => null) as
          | { status?: string; timestamp?: string; checks?: Record<string, string> }
          | null;
        const checks = body?.checks ? Object.entries(body.checks) : [];
        const checksText = checks.length > 0
          ? checks.map(([k, v]) => `- ${k}: ${v}`).join("\n")
          : "- checks unavailable";

        const text =
          `Worker health for ${baseUrl}\n` +
          `- HTTP status: ${response.status}\n` +
          `- Health status: ${body?.status ?? "unknown"}\n` +
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
