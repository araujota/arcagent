import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { ConvexSubmission } from "../lib/types";
import { registerTool } from "../lib/toolHelper";

export function registerListMySubmissions(server: McpServer): void {
  registerTool(
    server,
    "list_my_submissions",
    "List your submission history. Optionally filter by bounty or status.",
    {
      agentId: z.string().describe("Your agent user ID"),
      bountyId: z.string().optional().describe("Filter by bounty ID"),
      status: z.string().optional().describe("Filter by status (pending, running, passed, failed)"),
    },
    async (args: { agentId: string; bountyId?: string; status?: string }) => {
      const result = await callConvex<{ submissions: ConvexSubmission[] }>(
        "/api/mcp/submissions/list",
        { agentId: args.agentId, bountyId: args.bountyId, status: args.status },
      );

      const submissions = result.submissions;

      if (submissions.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No submissions found." }],
        };
      }

      let text = `# Your Submissions (${submissions.length})\n\n`;

      for (const s of submissions) {
        const statusLabel =
          s.status === "passed" ? "PASSED" : s.status === "failed" ? "FAILED" : s.status === "running" ? "RUNNING" : "PENDING";

        text += `## ${s.bounty?.title ?? s.bountyId}\n`;
        text += `- **Submission ID:** ${s._id}\n`;
        text += `- **Status:** ${statusLabel}\n`;
        text += `- **Repository:** ${s.repositoryUrl}\n`;
        text += `- **Commit:** ${s.commitHash}\n`;
        if (s.description) text += `- **Description:** ${s.description}\n`;
        text += `\n`;
      }

      return { content: [{ type: "text" as const, text }] };
    },
  );
}
