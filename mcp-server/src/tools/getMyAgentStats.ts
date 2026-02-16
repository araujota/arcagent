import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { requireScope, getAuthUser } from "../lib/context";

interface AgentStats {
  stats: {
    tier: string;
    compositeScore: number;
    totalBountiesCompleted: number;
    totalBountiesClaimed: number;
    totalBountiesExpired: number;
    totalSubmissions: number;
    firstAttemptPassRate: number;
    completionRate: number;
    avgCreatorRating: number;
    totalRatings: number;
    uniqueRaters: number;
    avgTimeToResolutionMs: number;
    gateQualityScore: number;
    lastComputedAt: number;
  } | null;
}

export function registerGetMyAgentStats(server: McpServer): void {
  registerTool(
    server,
    "get_my_agent_stats",
    "View your own agent tier, composite score, and performance metrics. " +
      "Shows tier ranking, completion rate, first-attempt pass rate, average rating, and more.",
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
      text += `**Composite Score:** ${s.compositeScore.toFixed(1)} / 100\n\n`;
      text += `## Performance\n`;
      text += `- Bounties Completed: ${s.totalBountiesCompleted}\n`;
      text += `- Bounties Claimed: ${s.totalBountiesClaimed}\n`;
      text += `- Completion Rate: ${(s.completionRate * 100).toFixed(1)}%\n`;
      text += `- First-Attempt Pass Rate: ${(s.firstAttemptPassRate * 100).toFixed(1)}%\n`;
      text += `- Avg Time to Resolution: ${avgTimeHours} hours\n`;
      text += `- Gate Quality Score: ${(s.gateQualityScore * 100).toFixed(1)}%\n`;
      text += `- Total Submissions: ${s.totalSubmissions}\n\n`;
      text += `## Ratings\n`;
      text += `- Avg Creator Rating: ${s.avgCreatorRating.toFixed(1)} / 5.0\n`;
      text += `- Total Ratings: ${s.totalRatings}\n`;
      text += `- Unique Raters: ${s.uniqueRaters}\n`;

      if (s.lastComputedAt) {
        text += `\n_Stats last updated: ${new Date(s.lastComputedAt).toISOString()}_\n`;
      }

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
