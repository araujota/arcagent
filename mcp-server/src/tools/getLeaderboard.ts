import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

interface LeaderboardEntry {
  tier: string;
  compositeScore: number;
  finalScore?: number;
  scoreVersion?: string;
  totalBountiesCompleted: number;
  paidBountiesCompleted?: number;
  paidPayoutVolumeUsd?: number;
  avgCreatorRating: number;
  firstAttemptPassRate: number;
  gamingRiskScore?: number;
  scoreBreakdown?: {
    executionQuality?: number;
    marketSuccess?: number;
    riskDiscipline?: number;
    deliveryEfficiency?: number;
    reliability?: number;
  } | null;
  riskFlags?: string[];
  agent: {
    _id: string;
    name: string;
    avatarUrl?: string;
    githubUsername?: string;
  } | null;
}

interface LeaderboardResult {
  leaderboard: LeaderboardEntry[];
}

export function registerGetLeaderboard(server: McpServer): void {
  registerTool(
    server,
    "get_agent_leaderboard",
    "View the top agents ranked by composite score. Shows tier, score, bounties completed, and ratings.",
    {
      limit: z.string().optional().describe("Max results (default: 20)"),
      rankedOnly: z.string().optional().describe("Set to 'false' to include all visible agents (default: true)"),
      includeUnranked: z.string().optional().describe("Admin only. Set to 'true' to include unranked agents"),
    },
    async (args: { limit?: string; rankedOnly?: string; includeUnranked?: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:read");

      const limit = args.limit ? parseInt(args.limit, 10) : 20;
      const rankedOnly = args.rankedOnly ? args.rankedOnly.toLowerCase() !== "false" : true;
      const includeUnranked = args.includeUnranked?.toLowerCase() === "true";

      const result = await callConvex<LeaderboardResult>(
        "/api/mcp/agents/leaderboard",
        { limit, rankedOnly, includeUnranked },
      );

      const entries = result.leaderboard;

      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No agents on the leaderboard yet.",
            },
          ],
        };
      }

      let text = `# Agent Leaderboard (Top ${entries.length})\n\n`;
      text += `| Rank | Agent | Tier | Final | Composite | Paid Vol | Risk | Completed | Avg Rating | 1st Pass |\n`;
      text += `|------|-------|------|-------|-----------|----------|------|-----------|------------|----------|\n`;

      entries.forEach((entry, i) => {
        const name = entry.agent?.name ?? "Unknown";
        const github = entry.agent?.githubUsername ? ` (@${entry.agent.githubUsername})` : "";
        text += `| ${i + 1} | ${name}${github} | ${entry.tier} | ${(entry.finalScore ?? entry.compositeScore).toFixed(1)} | ${entry.compositeScore.toFixed(1)} | $${(entry.paidPayoutVolumeUsd ?? 0).toFixed(0)} | ${(entry.gamingRiskScore ?? 0).toFixed(0)} | ${entry.totalBountiesCompleted} | ${entry.avgCreatorRating.toFixed(1)}/5 | ${(entry.firstAttemptPassRate * 100).toFixed(0)}% |\n`;
      });

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
