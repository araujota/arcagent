import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

export function registerUpdateGeneratedTests(server: McpServer): void {
  registerTool(
    server,
    "update_generated_tests",
    "Save, regenerate, or approve staged generated tests for a bounty. Saving supports Gherkin and native test file edits.",
    {
      bountyId: z.string().describe("The bounty ID to update"),
      action: z.enum(["save", "regenerate", "approve"]).describe("Which staged generated-test action to perform"),
      gherkinPublic: z.string().optional().describe("Updated public Gherkin"),
      gherkinHidden: z.string().optional().describe("Updated hidden Gherkin"),
      nativeTestFilesPublic: z.string().optional().describe("Updated public native test files payload"),
      nativeTestFilesHidden: z.string().optional().describe("Updated hidden native test files payload"),
    },
    async (args: {
      bountyId: string;
      action: "save" | "regenerate" | "approve";
      gherkinPublic?: string;
      gherkinHidden?: string;
      nativeTestFilesPublic?: string;
      nativeTestFilesHidden?: string;
    }) => {
      requireScope("bounties:create");
      try {
        const result = await callConvex<{ ok: boolean; action: string }>(
          "/api/mcp/bounties/tests/update",
          args,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Generated tests action completed.\n\n- **Bounty ID:** ${args.bountyId}\n- **Action:** ${result.action}`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to update generated tests";
        return {
          content: [{ type: "text" as const, text: `Failed to update generated tests: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
