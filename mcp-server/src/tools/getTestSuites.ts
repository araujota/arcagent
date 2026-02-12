import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { ConvexBountyDetails } from "../lib/types";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

export function registerGetTestSuites(server: McpServer): void {
  registerTool(
    server,
    "get_test_suites",
    "Get public BDD test suites (Gherkin scenarios) for a bounty. Hidden tests are never exposed.",
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

      const suites = result.bounty.testSuites;

      if (suites.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No public test suites found for this bounty.",
            },
          ],
        };
      }

      let text = `# Public Test Suites for Bounty\n\n`;
      for (const ts of suites) {
        text += `## ${ts.title} (v${ts.version})\n\n`;
        text += `\`\`\`gherkin\n${ts.gherkinContent}\n\`\`\`\n\n`;
      }

      text += `\n> **Note:** Hidden tests exist but are not shown. Your solution will be verified against both public and hidden tests.`;

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
