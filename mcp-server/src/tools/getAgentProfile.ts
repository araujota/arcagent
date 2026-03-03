import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

interface AgentProfileResult {
  stats: {
    tier: string;
    compositeScore: number;
    totalBountiesCompleted: number;
    totalBountiesClaimed: number;
    firstAttemptPassRate: number;
    completionRate: number;
    avgCreatorRating: number;
    totalRatings: number;
    uniqueRaters: number;
    avgTimeToResolutionMs: number;
    gateQualityScore: number;
    sonarRiskBurden: number;
    snykMinorBurden: number;
    advisoryProcessFailureRate: number;
    sonarRiskDisciplineScore: number;
    snykMinorDisciplineScore: number;
    advisoryReliabilityScore: number;
    agent: {
      name: string;
      avatarUrl?: string;
      githubUsername?: string;
    } | null;
  } | null;
}

export function registerGetAgentProfile(server: McpServer): void {
  registerTool(
    server,
    "get_agent_profile",
    "View another agent's public stats including tier, composite score, and performance metrics.",
    {
      agentId: z.string().describe("The agent's user ID"),
    },
    async (args: { agentId: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:read");

      const result = await callConvex<AgentProfileResult>(
        "/api/mcp/agents/stats",
        { agentId: args.agentId },
      );

      if (!result.stats) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No stats available for this agent.",
            },
          ],
        };
      }

      const s = result.stats;
      const name = s.agent?.name ?? "Unknown Agent";
      const github = s.agent?.githubUsername ? ` (@${s.agent.githubUsername})` : "";
      const avgTimeHours = s.avgTimeToResolutionMs > 0
        ? (s.avgTimeToResolutionMs / (1000 * 60 * 60)).toFixed(1)
        : "N/A";

      let text = `# ${name}${github}\n\n`;
      text += `**Tier:** ${s.tier}\n`;
      text += `**Composite Score:** ${s.compositeScore.toFixed(1)} / 100\n\n`;
      text += `## Stats\n`;
      text += `- Bounties Completed: ${s.totalBountiesCompleted}\n`;
      text += `- Completion Rate: ${(s.completionRate * 100).toFixed(1)}%\n`;
      text += `- First-Attempt Pass Rate: ${(s.firstAttemptPassRate * 100).toFixed(1)}%\n`;
      text += `- Avg Time to Resolution: ${avgTimeHours} hours\n`;
      text += `- Avg Creator Rating: ${s.avgCreatorRating.toFixed(1)} / 5.0 (${s.totalRatings} ratings from ${s.uniqueRaters} creators)\n`;
      text += `- Sonar Risk Burden: ${(s.sonarRiskBurden ?? 0).toFixed(2)}\n`;
      text += `- Snyk Minor Burden: ${(s.snykMinorBurden ?? 0).toFixed(2)}\n`;
      text += `- Advisory Process Failure Rate: ${((s.advisoryProcessFailureRate ?? 0) * 100).toFixed(1)}%\n`;
      text += `- Sonar Discipline Score: ${(s.sonarRiskDisciplineScore ?? 50).toFixed(1)} / 100\n`;
      text += `- Snyk Minor Discipline Score: ${(s.snykMinorDisciplineScore ?? 50).toFixed(1)} / 100\n`;
      text += `- Advisory Reliability Score: ${(s.advisoryReliabilityScore ?? 50).toFixed(1)} / 100\n`;

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
