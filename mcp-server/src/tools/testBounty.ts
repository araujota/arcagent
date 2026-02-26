import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";

export function registerTestBounty(server: McpServer): void {
  registerTool(
    server,
    "testbounty",
    "Create and auto-claim a per-agent onboarding test bounty on this repo. This exercises the standard bounty lifecycle (claim/workspace/submit/verify) without payout.",
    {
      note: z.string().optional().describe("Optional note for logging context"),
    },
    async () => {
      requireScope("bounties:create");
      requireScope("bounties:claim");

      const authUser = getAuthUser();
      const agentId = authUser?.userId;
      if (!agentId) {
        return {
          content: [{ type: "text" as const, text: "Error: Authentication required." }],
          isError: true,
        };
      }

      try {
        const result = await callConvex<{
          bountyId: string;
          claimId: string;
          repositoryUrl: string;
          commitSha: string;
          testBountyKind: string;
          message: string;
        }>("/api/mcp/testbounty/create", { agentId });

        let text = "# Test Bounty Ready\n\n";
        text += `**Bounty ID:** ${result.bountyId}\n`;
        text += `**Claim ID:** ${result.claimId}\n`;
        text += `**Kind:** ${result.testBountyKind}\n`;
        text += `**Repository:** ${result.repositoryUrl}\n`;
        text += `**Commit:** ${result.commitSha}\n\n`;
        text += "## Next Steps\n\n";
        text += "1. Run `workspace_status` with this bounty ID until workspace is ready\n";
        text += "2. Implement the /agenthellos change in the workspace\n";
        text += "3. Run `submit_solution` when complete\n";
        text += "4. Monitor with `get_verification_status`\n\n";
        text += "On pass, payout is skipped but Stripe payout-readiness handshake is recorded.";

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to create test bounty";
        return {
          content: [{ type: "text" as const, text: `Failed to create test bounty: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
