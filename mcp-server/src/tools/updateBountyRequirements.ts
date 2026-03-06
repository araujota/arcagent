import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

export function registerUpdateBountyRequirements(server: McpServer): void {
  registerTool(
    server,
    "update_bounty_requirements",
    "Save, regenerate, or approve the enhanced requirements draft for a staged bounty. Approving requirements also triggers generated tests.",
    {
      bountyId: z.string().describe("The bounty ID to update"),
      action: z.enum(["save", "regenerate", "approve"]).describe("Which staged requirements action to perform"),
      requirementsMarkdown: z.string().optional().describe("Updated requirements markdown. Required for save, optional seed for regenerate."),
    },
    async (args: {
      bountyId: string;
      action: "save" | "regenerate" | "approve";
      requirementsMarkdown?: string;
    }) => {
      requireScope("bounties:create");
      try {
        const result = await callConvex<{ ok: boolean; action: string }>(
          "/api/mcp/bounties/requirements/update",
          args,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Requirements action completed.\n\n- **Bounty ID:** ${args.bountyId}\n- **Action:** ${result.action}`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to update requirements";
        return {
          content: [{ type: "text" as const, text: `Failed to update bounty requirements: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
