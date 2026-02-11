import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { createFork, generateForkAccessToken } from "../github/forkManager";
import { ConvexBountyDetails } from "../lib/types";
import { registerTool } from "../lib/toolHelper";

export function registerClaimBounty(server: McpServer): void {
  registerTool(
    server,
    "claim_bounty",
    "Claim an exclusive lock on a bounty. Optionally forks the repository. Only one agent can claim a bounty at a time. Claims expire after the bounty's claim duration (default 4 hours).",
    {
      bountyId: z.string().describe("The bounty ID to claim"),
      agentId: z.string().describe("Your agent user ID (from registration)"),
      forkRepo: z.string().optional().describe("Set to 'false' to skip forking (default: fork)"),
    },
    async (args: { bountyId: string; agentId: string; forkRepo?: string }) => {
      const bountyResult = await callConvex<{
        bounty: ConvexBountyDetails & { repositoryUrl?: string };
      }>("/api/mcp/bounties/get", { bountyId: args.bountyId });

      const bounty = bountyResult.bounty;

      let claimResult: { claimId: string };
      try {
        claimResult = await callConvex<{ claimId: string }>(
          "/api/mcp/claims/create",
          { bountyId: args.bountyId, agentId: args.agentId },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to claim bounty";
        return {
          content: [{ type: "text" as const, text: `Failed to claim bounty: ${message}` }],
          isError: true,
        };
      }

      const claimId = claimResult.claimId;
      let text = `# Bounty Claimed Successfully\n\n`;
      text += `**Claim ID:** ${claimId}\n`;
      text += `**Bounty:** ${bounty.title}\n`;
      text += `**Expires:** ${bounty.claimDurationHours} hours from now\n\n`;

      const shouldFork = args.forkRepo !== "false";
      if (shouldFork && bounty.repositoryUrl) {
        try {
          const match = bounty.repositoryUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
          if (match) {
            const [, owner, repo] = match;
            const bountyIdSuffix = args.bountyId.slice(-6);
            const agentIdSuffix = args.agentId.slice(-6);

            const fork = await createFork(
              owner!, repo!.replace(/\.git$/, ""), bountyIdSuffix, agentIdSuffix,
            );

            const expiresAt = Date.now() + (bounty.claimDurationHours ?? 4) * 60 * 60 * 1000;
            const access = await generateForkAccessToken(fork.forkFullName, expiresAt);

            await callConvex("/api/mcp/claims/update-fork", {
              claimId,
              forkRepositoryUrl: fork.forkUrl,
              forkAccessToken: access.accessToken,
              forkTokenExpiresAt: access.tokenExpiresAt,
            });

            text += `## Repository Fork\n\n`;
            text += `**Fork URL:** ${fork.forkUrl}\n`;
            text += `**Clone:** \`${access.cloneCommand}\`\n`;
            text += `**Token Expires:** ${new Date(access.tokenExpiresAt).toISOString()}\n\n`;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Fork creation failed";
          text += `\n> **Warning:** Repository fork failed: ${message}\n`;
          text += `> You can still work with your own repository.\n\n`;
        }
      }

      text += `## Next Steps\n\n`;
      text += `1. Clone the fork (or use your own repo)\n`;
      text += `2. Implement the solution\n`;
      text += `3. Push your changes\n`;
      text += `4. Call \`submit_solution\` with the repository URL and commit hash\n`;
      text += `\nUse \`extend_claim\` if you need more time. Use \`release_claim\` to give up the bounty.`;

      return { content: [{ type: "text" as const, text }] };
    },
  );
}
