import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { ConvexBountyDetails } from "../lib/types";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";
import { invalidateWorkspaceCache } from "../workspace/cache";

export function registerClaimBounty(server: McpServer): void {
  registerTool(
    server,
    "claim_bounty",
    "Claim an exclusive lock on a bounty. A workspace is provisioned automatically with the repository pre-cloned. Only one agent can claim a bounty at a time. Claims expire after the bounty's claim duration (default 4 hours).",
    {
      bountyId: z.string().describe("The bounty ID to claim"),
    },
    async (args: { bountyId: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:claim");
      // SECURITY (C1): Resolve agentId from auth context, not from params
      const authUser = getAuthUser();
      const agentId = authUser?.userId;
      if (!agentId) {
        return {
          content: [{ type: "text" as const, text: "Error: Authentication required. No agent ID available." }],
          isError: true,
        };
      }

      const bountyResult = await callConvex<{
        bounty: ConvexBountyDetails & { repositoryUrl?: string };
      }>("/api/mcp/bounties/get", { bountyId: args.bountyId });

      const bounty = bountyResult.bounty;

      let claimResult: {
        claimId: string;
        repoInfo: { owner: string; repo: string; baseBranch: string; repositoryUrl: string } | null;
      };
      try {
        claimResult = await callConvex<{
          claimId: string;
          repoInfo: { owner: string; repo: string; baseBranch: string; repositoryUrl: string } | null;
        }>(
          "/api/mcp/claims/create",
          { bountyId: args.bountyId, agentId },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to claim bounty";
        return {
          content: [{ type: "text" as const, text: `Failed to claim bounty: ${message}` }],
          isError: true,
        };
      }

      const { claimId } = claimResult;
      invalidateWorkspaceCache(agentId, args.bountyId);
      let text = `# Bounty Claimed Successfully\n\n`;
      text += `**Claim ID:** ${claimId}\n`;
      text += `**Bounty:** ${bounty.title}\n`;
      text += `**Expires:** ${bounty.claimDurationHours} hours from now\n\n`;

      text += `## Development Workspace\n\n`;
      text += `A Firecracker microVM execution environment is being provisioned by the shared worker with the repository pre-cloned.\n`;
      text += `Use \`workspace_status\` to check when it's ready (~30-90 seconds).\n\n`;

      text += `## Available Tools\n\n`;
      text += `- \`workspace_exec\` — Run shell commands (build, test, install packages)\n`;
      text += `- \`workspace_exec_stream\` — Run long commands (npm test, cargo build) with streaming output\n`;
      text += `- \`workspace_read_file\` — Read a single source file\n`;
      text += `- \`workspace_batch_read\` — Read multiple files in one call (much faster)\n`;
      text += `- \`workspace_write_file\` — Write/create a single file\n`;
      text += `- \`workspace_batch_write\` — Write multiple files in one call\n`;
      text += `- \`workspace_search\` — Search for patterns across files (structured grep)\n`;
      text += `- \`workspace_list_files\` — List files with optional glob filter\n`;
      text += `- \`submit_solution\` — Submit your changes for verification\n\n`;

      text += `All development happens inside the VM. You do not need to clone or push to any repository.\n`;
      text += `\nUse \`extend_claim\` if you need more time. Use \`release_claim\` to give up the bounty.`;

      return { content: [{ type: "text" as const, text }] };
    },
  );
}
