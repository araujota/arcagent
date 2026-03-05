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

function isOwnClaim(authUser: ReturnType<typeof getAuthUser>, claim: ClaimInfo): boolean {
  return authUser?.userId === claim.agentId;
}

function buildBountyHeader(bounty: ConvexBountyDetails): string {
  return [
    `# Claim Status for "${bounty.title}"`,
    "",
    `**Bounty Status:** ${bounty.status}`,
    `**Is Claimed:** ${bounty.isClaimed ? "Yes" : "No"}`,
    "",
  ].join("\n");
}

function buildWorkspaceDetails(ws: {
  found: boolean;
  status?: string;
  workspaceId?: string;
  expiresAt?: number;
}): string {
  if (!ws.found) {
    return "\n**Workspace:** Not provisioned. Use `workspace_status` to check.\n";
  }

  const lines = [
    "\n### Workspace",
    `**Status:** ${ws.status ?? "unknown"}`,
    `**Workspace ID:** ${ws.workspaceId}`,
  ];
  const wsRemaining = (ws.expiresAt ?? 0) - Date.now();
  if (wsRemaining > 0) {
    const mins = Math.floor(wsRemaining / 60000);
    const hours = Math.floor(mins / 60);
    lines.push(`**Time remaining:** ${hours}h ${mins % 60}m`);
  }
  return `${lines.join("\n")}\n`;
}

function buildOwnClaimActionText(): string {
  return [
    "Use `workspace_status` to check your dev environment, `extend_claim` to extend the deadline, `release_claim` to give it up, or `submit_solution` to submit your work.",
    "",
    "If you pause or stop work on this claim, run `release_claim` immediately so the workspace slot is returned to the shared worker pool.",
  ].join("\n");
}

function buildClaimDetailsText(args: {
  claim: ClaimInfo;
  isOwnClaim: boolean;
}): string {
  const timeLeft = args.claim.expiresAt - Date.now();
  const hoursLeft = Math.max(0, timeLeft / (1000 * 60 * 60));
  return [
    `**Claim ID:** ${args.claim.claimId}`,
    `**Your Claim:** ${args.isOwnClaim ? "Yes" : "No"}`,
    `**Expires:** ${new Date(args.claim.expiresAt).toISOString()} (${hoursLeft.toFixed(1)} hours remaining)`,
    `**Submissions:** ${args.claim.submissionCount} / ${args.claim.maxSubmissions}`,
    "",
  ].join("\n");
}

async function appendWorkspaceSection(args: {
  text: string;
  authUser: NonNullable<ReturnType<typeof getAuthUser>>;
  bountyId: string;
}): Promise<string> {
  try {
    const ws = await getWorkspaceForAgent(args.authUser.userId, args.bountyId);
    return args.text + buildWorkspaceDetails(ws);
  } catch {
    // Workspace lookup failed — not critical
    return args.text;
  }
}

function buildClaimOwnershipFooter(isOwner: boolean): string {
  if (isOwner) {
    return buildOwnClaimActionText();
  }
  return "This bounty is claimed by another agent. It will become available after the claim expires.";
}

async function buildClaimedBountyText(args: {
  bountyId: string;
  authUser: ReturnType<typeof getAuthUser>;
}): Promise<string> {
  try {
    const claimResult = await callConvex<{ claim: ClaimInfo | null }>(
      "/api/mcp/claims/get",
      { bountyId: args.bountyId },
    );
    const claim = claimResult.claim;
    if (!claim) {
      return "";
    }

    const ownerClaim = isOwnClaim(args.authUser, claim);
    let text = buildClaimDetailsText({ claim, isOwnClaim: ownerClaim });
    if (ownerClaim && args.authUser) {
      text = await appendWorkspaceSection({
        text,
        authUser: args.authUser,
        bountyId: args.bountyId,
      });
    }

    return `${text}\n${buildClaimOwnershipFooter(ownerClaim)}`;
  } catch {
    return "This bounty is currently claimed. If this is your claim, use `extend_claim` to extend the deadline or `release_claim` to give it up.";
  }
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

      let text = buildBountyHeader(bounty);

      if (!bounty.isClaimed) {
        text += `This bounty is available for claiming. Use \`claim_bounty\` to claim it.`;
      } else {
        text += await buildClaimedBountyText({
          bountyId: args.bountyId,
          authUser,
        });
      }

      return { content: [{ type: "text" as const, text }] };
    },
  );
}
