import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { ConvexBountyDetails } from "../lib/types";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";

interface ClaimInfo {
  claimId: string;
  agentId: string;
  status: string;
  expiresAt: number;
  featureBranchName?: string;
  featureBranchRepo?: string;
  submissionCount: number;
  maxSubmissions: number;
}

export function registerGetClaimStatus(server: McpServer): void {
  registerTool(
    server,
    "get_claim_status",
    "Check claim details for a bounty. Shows active claim status, expiry, workspace status, and submission attempts.",
    {
      bountyId: z.string().describe("The bounty ID to check"),
    },
    async (args: { bountyId: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:read");
      const authUser = getAuthUser();

      const result = await callConvex<{ bounty: ConvexBountyDetails }>(
        "/api/mcp/bounties/get",
        { bountyId: args.bountyId },
      );

      const bounty = result.bounty;

      let text = `# Claim Status for "${bounty.title}"\n\n`;
      text += `**Bounty Status:** ${bounty.status}\n`;
      text += `**Is Claimed:** ${bounty.isClaimed ? "Yes" : "No"}\n\n`;

      if (!bounty.isClaimed) {
        text += `This bounty is available for claiming. Use \`claim_bounty\` to claim it.`;
      } else {
        // Fetch detailed claim info
        try {
          const claimResult = await callConvex<{ claim: ClaimInfo | null }>(
            "/api/mcp/claims/get",
            { bountyId: args.bountyId },
          );
          const claim = claimResult.claim;
          if (claim) {
            const isOwnClaim = authUser && claim.agentId === authUser.userId;
            const expiryDate = new Date(claim.expiresAt).toISOString();
            const timeLeft = claim.expiresAt - Date.now();
            const hoursLeft = Math.max(0, timeLeft / (1000 * 60 * 60));

            text += `**Claim ID:** ${claim.claimId}\n`;
            text += `**Your Claim:** ${isOwnClaim ? "Yes" : "No"}\n`;
            text += `**Expires:** ${expiryDate} (${hoursLeft.toFixed(1)} hours remaining)\n`;
            text += `**Submissions:** ${claim.submissionCount} / ${claim.maxSubmissions}\n`;

            // Show workspace status if this is the agent's own claim
            if (isOwnClaim && authUser) {
              try {
                const ws = await getWorkspaceForAgent(authUser.userId, args.bountyId);
                if (ws.found) {
                  text += `\n### Workspace\n`;
                  text += `**Status:** ${ws.status}\n`;
                  text += `**Workspace ID:** ${ws.workspaceId}\n`;
                  const wsRemaining = ws.expiresAt - Date.now();
                  if (wsRemaining > 0) {
                    const mins = Math.floor(wsRemaining / 60000);
                    const hours = Math.floor(mins / 60);
                    text += `**Time remaining:** ${hours}h ${mins % 60}m\n`;
                  }
                } else {
                  text += `\n**Workspace:** Not provisioned. Use \`workspace_status\` to check.\n`;
                }
              } catch {
                // Workspace lookup failed — not critical
              }
            }

            text += `\n`;
            if (isOwnClaim) {
              text += `Use \`workspace_status\` to check your dev environment, \`extend_claim\` to extend the deadline, \`release_claim\` to give it up, or \`submit_solution\` to submit your work.`;
            } else {
              text += `This bounty is claimed by another agent. It will become available after the claim expires.`;
            }
          }
        } catch {
          // Fallback if claim details endpoint doesn't exist yet
          text += `This bounty is currently claimed. If this is your claim, use \`extend_claim\` to extend the deadline or \`release_claim\` to give it up.`;
        }
      }

      return { content: [{ type: "text" as const, text }] };
    },
  );
}
