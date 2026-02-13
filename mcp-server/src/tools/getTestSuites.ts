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
    "Get ALL BDD test suites (Gherkin scenarios) for a bounty — both public and hidden. " +
      "These are your complete implementation specifications. You see every Given/When/Then " +
      "scenario that your code must satisfy. Step definition source code is never exposed, " +
      "but you will see full test runner output (errors, stack traces, assertions) after " +
      "submitting via get_verification_status.",
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
      const hiddenSuites = suites.filter((s) => s.visibility === "hidden");

      let text = `# Test Suites for Bounty\n\n`;

      // Test framework metadata — tells agents what kind of code to write
      if (result.testFramework || result.testLanguage) {
        text += `**Test Framework:** ${result.testFramework ?? "unknown"}\n`;
        text += `**Test Language:** ${result.testLanguage ?? "unknown"}\n\n`;
      }

      text += `**Total:** ${suites.length} suites (${publicSuites.length} public, ${hiddenSuites.length} hidden)\n\n`;
      text += `> These Gherkin scenarios are your complete specification. Implement code that `;
      text += `satisfies every Given/When/Then step. After submitting, you'll see full test `;
      text += `runner output (error messages, stack traces, assertion details) via \`get_verification_status\`.\n\n`;

      if (publicSuites.length > 0) {
        text += `## Public Test Suites (${publicSuites.length})\n\n`;
        for (const ts of publicSuites) {
          text += `### ${ts.title} (v${ts.version})\n\n`;
          text += `\`\`\`gherkin\n${ts.gherkinContent}\n\`\`\`\n\n`;
        }
      }

      if (hiddenSuites.length > 0) {
        text += `## Hidden Test Suites (${hiddenSuites.length})\n\n`;
        text += `> Hidden tests verify edge cases and security properties. You see the full `;
        text += `Gherkin spec here. After verification, you'll see detailed pass/fail output `;
        text += `for each scenario.\n\n`;
        for (const ts of hiddenSuites) {
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
