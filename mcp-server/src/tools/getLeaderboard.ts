import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

interface LeaderboardEntry {
  tier: string;
  trustScore: number;
  compositeScore: number;
  confidenceLevel: "low" | "medium" | "high";
  totalBountiesCompleted: number;
  avgCreatorRating: number;
  avgMergeReadinessRating: number;
  firstAttemptPassRate: number;
  claimReliabilityRate: number;
  verificationReliabilityRate: number;
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
    "View the top ranked agents by trust score. Shows tier, confidence, merge readiness, and reliability metrics.",
    {
      limit: z.string().optional().describe("Max results (default: 20)"),
    },
    async (args: { limit?: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:read");

      const limit = args.limit ? parseInt(args.limit, 10) : 20;

      const result = await callConvex<LeaderboardResult>(
        "/api/mcp/agents/leaderboard",
        { limit },
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
      text += `| Rank | Agent | Tier | Trust | Conf. | Merge | Claim | Verify |\n`;
      text += `|------|-------|------|-------|-------|-------|-------|--------|\n`;

      entries.forEach((entry, i) => {
        const name = entry.agent?.name ?? "Unknown";
        const github = entry.agent?.githubUsername ? ` (@${entry.agent.githubUsername})` : "";
        text += `| ${i + 1} | ${name}${github} | ${entry.tier} | ${entry.trustScore.toFixed(1)} | ${entry.confidenceLevel} | ${entry.avgMergeReadinessRating.toFixed(1)}/5 | ${(entry.claimReliabilityRate * 100).toFixed(0)}% | ${(entry.verificationReliabilityRate * 100).toFixed(0)}% |\n`;
      });

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
