import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { ConvexBountyDetails } from "../lib/types";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

export function registerGetBountyDetails(server: McpServer): void {
  registerTool(
    server,
    "get_bounty_details",
    "Get full details for a bounty including description, reward, ALL test suites " +
      "(public + hidden Gherkin), repo structure, test framework info, and claim status. " +
      "This gives you everything you need to understand what to build.",
    {
      bountyId: z.string().describe("The bounty ID"),
    },
    async (args: { bountyId: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:read");
      const result = await callConvex<{ bounty: ConvexBountyDetails }>(
        "/api/mcp/bounties/get",
        { bountyId: args.bountyId },
      );

      const b = result.bounty;

      let text = `# ${b.title}\n\n`;
      text += `**Status:** ${b.status}\n`;
      text += `**Reward:** ${b.reward} ${b.rewardCurrency}\n`;
      if (b.rewardCurrency === "USD") {
        const pct = b.platformFeePercent ?? 0.08;
        const solverAmount = (b.reward * (1 - pct)).toFixed(2);
        text += `**Solver receives:** ${solverAmount} ${b.rewardCurrency} (${(pct * 100).toFixed(0)}% platform fee)\n`;
      }
      if (b.creator) text += `**Creator:** ${b.creator.name}\n`;
      if (b.tags?.length) text += `**Tags:** ${b.tags.join(", ")}\n`;
      if (b.deadline)
        text += `**Deadline:** ${new Date(b.deadline).toISOString()}\n`;
      text += `**Claimed:** ${b.isClaimed ? "Yes (locked by another agent)" : "No (available)"}\n`;
      text += `**Claim Duration:** ${b.claimDurationHours} hours\n`;
      if ((b as any).requiredTier) {
        text += `**Required Tier:** ${(b as any).requiredTier} or above\n`;
      }

      // Test framework metadata
      if (b.testFramework || b.testLanguage) {
        text += `**Test Framework:** ${b.testFramework ?? "unknown"}\n`;
        text += `**Test Language:** ${b.testLanguage ?? "unknown"}\n`;
      }

      text += `\n## Description\n\n${b.description}\n`;

      // Show ALL test suites grouped by visibility
      if (b.testSuites.length > 0) {
        const publicSuites = b.testSuites.filter((ts) => ts.visibility === "public");
        const hiddenSuites = b.testSuites.filter((ts) => ts.visibility === "hidden");

        text += `\n## Test Suites (${b.testSuites.length} total: ${publicSuites.length} public, ${hiddenSuites.length} hidden)\n\n`;
        text += `> These Gherkin scenarios are your complete implementation specification. `;
        text += `Your code must satisfy every Given/When/Then step.\n`;

        if (publicSuites.length > 0) {
          text += `\n### Public Tests\n`;
          for (const ts of publicSuites) {
            text += `\n#### ${ts.title} (v${ts.version})\n\`\`\`gherkin\n${ts.gherkinContent}\n\`\`\`\n`;
          }
        }

        if (hiddenSuites.length > 0) {
          text += `\n### Hidden Tests\n`;
          text += `> Hidden tests verify edge cases and security properties.\n`;
          for (const ts of hiddenSuites) {
            text += `\n#### ${ts.title} (v${ts.version})\n\`\`\`gherkin\n${ts.gherkinContent}\n\`\`\`\n`;
          }
        }
      }

      if (b.repoMap) {
        text += `\n## Repository Structure\n\`\`\`\n${b.repoMap.repoMapText.slice(0, 3000)}\n\`\`\`\n`;
        text += `\n> Use \`get_repo_map\` for the full symbol table and dependency graph.\n`;
      }

      text += `\n## Next Steps\n\n`;
      text += `1. Use \`claim_bounty\` to claim this bounty and get a feature branch\n`;
      text += `2. Use \`get_repo_map\` for detailed code structure (symbols, dependencies)\n`;
      text += `3. Clone the repo and checkout the feature branch, implement the solution\n`;
      text += `4. Use \`submit_solution\` with your commit hash\n`;
      text += `5. Use \`get_verification_status\` to see full test output (errors, stack traces)\n`;

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
