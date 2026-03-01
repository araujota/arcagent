import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

interface VerificationLogEntry {
  _id: string;
  verificationId: string;
  submissionId: string;
  bountyId: string;
  agentId?: string;
  claimId?: string;
  source: "verification_result_callback" | "verification_lifecycle" | "verification_timeout" | "system";
  level: "info" | "warning" | "error";
  eventType: string;
  gate?: string;
  visibility?: "public" | "hidden";
  message: string;
  detailsJson?: string;
  createdAt: number;
}

interface VerificationLogsResponse {
  logs: VerificationLogEntry[];
}

export function registerGetVerificationLogs(server: McpServer): void {
  registerTool(
    server,
    "get_verification_logs",
    "Search persisted verification lifecycle logs by verification, submission, bounty, agent, and event filters.",
    {
      verificationId: z.string().optional().describe("Filter by verification ID"),
      submissionId: z.string().optional().describe("Filter by submission ID"),
      bountyId: z.string().optional().describe("Filter by bounty ID"),
      agentId: z.string().optional().describe("Filter by agent/user ID"),
      source: z.enum(["verification_result_callback", "verification_lifecycle", "verification_timeout", "system"]).optional().describe("Filter by log source"),
      level: z.enum(["info", "warning", "error"]).optional().describe("Filter by severity"),
      eventType: z.string().optional().describe("Filter by event type"),
      gate: z.string().optional().describe("Filter by gate name (e.g. build, test)"),
      visibility: z.enum(["public", "hidden"]).optional().describe("Filter by step visibility"),
      limit: z.number().int().min(1).max(1000).optional().describe("Max logs to return (default 200)"),
    },
    async (args: {
      verificationId?: string;
      submissionId?: string;
      bountyId?: string;
      agentId?: string;
      source?: "verification_result_callback" | "verification_lifecycle" | "verification_timeout" | "system";
      level?: "info" | "warning" | "error";
      eventType?: string;
      gate?: string;
      visibility?: "public" | "hidden";
      limit?: number;
    }) => {
      requireScope("bounties:read");

      try {
        const result = await callConvex<VerificationLogsResponse>(
          "/api/mcp/verifications/logs",
          {
            verificationId: args.verificationId,
            submissionId: args.submissionId,
            bountyId: args.bountyId,
            agentId: args.agentId,
            source: args.source,
            level: args.level,
            eventType: args.eventType,
            gate: args.gate,
            visibility: args.visibility,
            limit: args.limit,
          },
        );

        const logs = Array.isArray(result.logs) ? result.logs : [];
        if (logs.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No verification logs found for the provided filters.",
            }],
          };
        }

        let text = `# Verification Logs (${logs.length})\n\n`;
        text += `| Time (UTC) | Level | Source | Event | Message |\n`;
        text += `|------------|-------|--------|-------|---------|\n`;

        for (const log of logs.slice(0, 200)) {
          const ts = new Date(log.createdAt).toISOString();
          const msg = log.message.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 140);
          text += `| ${ts} | ${log.level} | ${log.source} | ${log.eventType} | ${msg} |\n`;
        }

        const sampleWithDetails = logs.find((l) => typeof l.detailsJson === "string" && l.detailsJson.length > 0);
        if (sampleWithDetails?.detailsJson) {
          text += `\n## Sample Details\n\n`;
          text += "```json\n";
          text += `${sampleWithDetails.detailsJson.slice(0, 4000)}\n`;
          text += "```\n";
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to get verification logs";
        return {
          content: [{ type: "text" as const, text: `Failed to get verification logs: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
