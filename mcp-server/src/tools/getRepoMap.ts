import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { ConvexBountyDetails } from "../lib/types";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

export function registerGetRepoMap(server: McpServer): void {
  registerTool(
    server,
    "get_repo_map",
    "Get the repository structure, symbol table, and dependency graph for a bounty's codebase.",
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

      const repoMap = result.bounty.repoMap;

      if (!repoMap) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No repository map available for this bounty. The repository may not have been indexed yet.",
            },
          ],
        };
      }

      let text = `# Repository Map\n\n`;
      text += `## File Structure\n\`\`\`\n${repoMap.repoMapText}\n\`\`\`\n\n`;

      try {
        const symbols = JSON.parse(repoMap.symbolTableJson);
        if (Array.isArray(symbols) && symbols.length > 0) {
          text += `## Symbol Table (${symbols.length} symbols)\n\`\`\`json\n${repoMap.symbolTableJson.slice(0, 5000)}\n\`\`\`\n\n`;
        }
      } catch {
        // symbolTableJson might not be valid JSON
      }

      try {
        const deps = JSON.parse(repoMap.dependencyGraphJson);
        if (deps && Object.keys(deps).length > 0) {
          text += `## Dependency Graph\n\`\`\`json\n${repoMap.dependencyGraphJson.slice(0, 3000)}\n\`\`\`\n`;
        }
      } catch {
        // dependencyGraphJson might not be valid JSON
      }

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
