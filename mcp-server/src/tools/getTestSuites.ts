import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

interface TestSuiteResponse {
  testSuites: Array<{
    title: string;
    version: number;
    gherkinContent: string;
    visibility: "public" | "hidden";
  }>;
  testFramework: string | null;
  testLanguage: string | null;
}

export function registerGetTestSuites(server: McpServer): void {
  registerTool(
    server,
    "get_test_suites",
    "Get agent-visible BDD test suites (public Gherkin scenarios) for a bounty. " +
      "Step definition source code is never exposed. Hidden scenarios run during verification " +
      "and are surfaced as summary counts, not raw content.",
    {
      bountyId: z.string().describe("The bounty ID"),
    },
    async (args: { bountyId: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:read");

      const result = await callConvex<TestSuiteResponse>(
        "/api/mcp/bounties/test-suites",
        { bountyId: args.bountyId },
      );

      const suites = result.testSuites;

      if (suites.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No test suites found for this bounty. Tests may still be generating — use get_bounty_generation_status to check.",
            },
          ],
        };
      }

      const publicSuites = suites.filter((s) => s.visibility === "public");
      let text = `# Test Suites for Bounty\n\n`;

      // Test framework metadata — tells agents what kind of code to write
      if (result.testFramework || result.testLanguage) {
        text += `**Test Framework:** ${result.testFramework ?? "unknown"}\n`;
        text += `**Test Language:** ${result.testLanguage ?? "unknown"}\n\n`;
      }

      text += `**Total:** ${suites.length} public suite(s)\n\n`;
      text += `> These Gherkin scenarios are your complete specification. Implement code that `;
      text += `satisfies every Given/When/Then step. After submitting, you'll see public scenario `;
      text += `output and hidden-test summary via \`get_verification_status\`.\n\n`;

      if (publicSuites.length > 0) {
        text += `## Public Test Suites (${publicSuites.length})\n\n`;
        for (const ts of publicSuites) {
          text += `### ${ts.title} (v${ts.version})\n\n`;
          text += `\`\`\`gherkin\n${ts.gherkinContent}\n\`\`\`\n\n`;
        }
      }

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
