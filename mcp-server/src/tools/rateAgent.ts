import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { requireScope, getAuthUser } from "../lib/context";

export function registerRateAgent(server: McpServer): void {
  registerTool(
    server,
    "rate_agent",
    "Rate an agent after a bounty is completed. Only the bounty creator can rate. " +
      "Each dimension is scored 1-5. Rating is optional but helps build agent reputation.",
    {
      bountyId: z.string().describe("The completed bounty ID"),
      codeQuality: z.string().describe("Code quality score (1-5)"),
      speed: z.string().describe("Speed/efficiency score (1-5)"),
      mergedWithoutChanges: z.string().describe("How close to merge-ready (1=heavy rework, 5=merged as-is)"),
      communication: z.string().describe("Communication quality score (1-5)"),
      testCoverage: z.string().describe("Test coverage quality score (1-5)"),
      comment: z.string().optional().describe("Optional comment about the agent's work"),
    },
    async (args: {
      bountyId: string;
      codeQuality: string;
      speed: string;
      mergedWithoutChanges: string;
      communication: string;
      testCoverage: string;
      comment?: string;
    }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:create");

      // SECURITY (C1): Get identity from auth context
      const user = getAuthUser();
      if (!user) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Authentication required. Use the HTTP transport with a valid API key.",
            },
          ],
          isError: true,
        };
      }

      const codeQuality = parseInt(args.codeQuality, 10);
      const speed = parseInt(args.speed, 10);
      const mergedWithoutChanges = parseInt(args.mergedWithoutChanges, 10);
      const communication = parseInt(args.communication, 10);
      const testCoverage = parseInt(args.testCoverage, 10);

      for (const [name, val] of [
        ["codeQuality", codeQuality],
        ["speed", speed],
        ["mergedWithoutChanges", mergedWithoutChanges],
        ["communication", communication],
        ["testCoverage", testCoverage],
      ] as const) {
        if (isNaN(val) || val < 1 || val > 5) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Invalid ${name}: must be an integer between 1 and 5.`,
              },
            ],
            isError: true,
          };
        }
      }

      try {
        const result = await callConvex<{ ratingId: string }>(
          "/api/mcp/ratings/submit",
          {
            bountyId: args.bountyId,
            creatorId: user.userId,
            codeQuality,
            speed,
            mergedWithoutChanges,
            communication,
            testCoverage,
            comment: args.comment,
          },
        );

        const avg = (codeQuality + speed + mergedWithoutChanges + communication + testCoverage) / 5;

        return {
          content: [
            {
              type: "text" as const,
              text: `Rating submitted successfully (ID: ${result.ratingId}).\n\n` +
                `Average: ${avg.toFixed(1)} / 5.0\n` +
                `- Code Quality: ${codeQuality}/5\n` +
                `- Speed: ${speed}/5\n` +
                `- Merged Without Changes: ${mergedWithoutChanges}/5\n` +
                `- Communication: ${communication}/5\n` +
                `- Test Coverage: ${testCoverage}/5`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to submit rating";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
