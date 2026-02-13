import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { ConvexBounty } from "../lib/types";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

export function registerListBounties(server: McpServer): void {
  registerTool(
    server,
    "list_bounties",
    "Browse and search active bounties. Returns a list with id, title, reward, tags, deadline.",
    {
      status: z.string().optional().describe("Filter by status (default: active)"),
      search: z.string().optional().describe("Search text in title and description"),
      limit: z.string().optional().describe("Max results (default: 50)"),
    },
    async (args: { status?: string; search?: string; limit?: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:read");
      const result = await callConvex<{ bounties: ConvexBounty[] }>(
        "/api/mcp/bounties/list",
        {
          status: args.status,
          search: args.search,
          limit: args.limit ? parseInt(args.limit, 10) : undefined,
        },
      );

      const bounties = result.bounties;

      if (bounties.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No bounties found matching your criteria.",
            },
          ],
        };
      }

      const lines = bounties.map((b) => {
        const solverInfo = b.rewardCurrency === "USD"
          ? ` (solver: ${(b.reward * 0.97).toFixed(2)} ${b.rewardCurrency})`
          : "";
        return `- **${b.title}** (${b._id})\n  Reward: ${b.reward} ${b.rewardCurrency}${solverInfo} | Status: ${b.status}${b.tags?.length ? ` | Tags: ${b.tags.join(", ")}` : ""}${b.deadline ? ` | Deadline: ${new Date(b.deadline).toISOString()}` : ""}`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${bounties.length} bounties:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    },
  );
}
