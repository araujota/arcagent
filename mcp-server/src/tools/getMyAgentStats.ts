import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { requireScope, getAuthUser } from "../lib/context";

interface AgentStats {
  stats: {
    tier: string;
    trustScore: number;
    compositeScore: number;
    confidenceLevel: "low" | "medium" | "high";
    totalBountiesCompleted: number;
    totalBountiesClaimed: number;
    totalBountiesExpired: number;
    totalSubmissions: number;
    firstAttemptPassRate: number;
    completionRate: number;
    claimReliabilityRate: number;
    verificationReliabilityRate: number;
    avgCreatorRating: number;
    avgMergeReadinessRating: number;
    totalRatings: number;
    uniqueRaters: number;
    eligibleUniqueRaters: number;
    avgTimeToResolutionMs: number;
    gateQualityScore: number;
    lastComputedAt: number;
  } | null;
}

export function registerGetMyAgentStats(server: McpServer): void {
  registerTool(
    server,
    "get_my_agent_stats",
    "View your own agent tier, trust score, and performance metrics. " +
      "Shows tier ranking, confidence, merge readiness, verification reliability, and more.",
    {},
    async () => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:read");

      // SECURITY (C1): Get identity from auth context
      const user = getAuthUser();
      if (!user) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Authentication required. Use the HTTP transport with a valid API key.",
            },
          ],
          isError: true,
        };
      }

      const result = await callConvex<AgentStats>("/api/mcp/agents/my-stats", {
        userId: user.userId,
      });

      if (!result.stats) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No stats available yet. Complete bounties to build your agent profile.",
            },
          ],
        };
      }

      const s = result.stats;
      const avgTimeHours = s.avgTimeToResolutionMs > 0
        ? (s.avgTimeToResolutionMs / (1000 * 60 * 60)).toFixed(1)
        : "N/A";

      let text = `# Your Agent Stats\n\n`;
      text += `**Tier:** ${s.tier}\n`;
      text += `**Trust Score:** ${s.trustScore.toFixed(1)} / 100\n`;
      text += `**Confidence:** ${s.confidenceLevel}\n\n`;
      text += `## Performance\n`;
      text += `- Bounties Completed: ${s.totalBountiesCompleted}\n`;
      text += `- Bounties Claimed: ${s.totalBountiesClaimed}\n`;
      text += `- Claim Reliability: ${(s.claimReliabilityRate * 100).toFixed(1)}%\n`;
      text += `- Verification Reliability: ${(s.verificationReliabilityRate * 100).toFixed(1)}%\n`;
      text += `- First-Attempt Pass Rate: ${(s.firstAttemptPassRate * 100).toFixed(1)}%\n`;
      text += `- Avg Time to Resolution: ${avgTimeHours} hours\n`;
      text += `- Merge Readiness: ${s.avgMergeReadinessRating.toFixed(1)} / 5.0\n`;
      text += `- Gate Quality Score: ${(s.gateQualityScore * 100).toFixed(1)}%\n`;
      text += `- Total Submissions: ${s.totalSubmissions}\n\n`;
      text += `## Ratings\n`;
      text += `- Avg Creator Rating: ${s.avgCreatorRating.toFixed(1)} / 5.0\n`;
      text += `- Total Ratings: ${s.totalRatings}\n`;
      text += `- Unique Raters: ${s.uniqueRaters} (${s.eligibleUniqueRaters} tier-eligible)\n`;

      if (s.lastComputedAt) {
        text += `\n_Stats last updated: ${new Date(s.lastComputedAt).toISOString()}_\n`;
      }

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
