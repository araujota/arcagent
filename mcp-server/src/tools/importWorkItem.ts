import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";

interface WorkItem {
  externalId: string;
  provider: "jira" | "linear" | "asana" | "monday";
  title: string;
  description: string;
  acceptanceCriteria?: string;
  labels: string[];
  estimate?: number;
  status: string;
  priority?: string;
  url: string;
}

export function registerImportWorkItem(server: McpServer): void {
  registerTool(
    server,
    "import_work_item",
    "Import a work item (issue/task/story) from Jira, Linear, Asana, or Monday.com. Returns structured data that can be used to pre-fill a bounty.",
    {
      provider: z.enum(["jira", "linear", "asana", "monday"]).describe("PM tool provider"),
      issueKey: z
        .string()
        .describe(
          "Issue identifier (e.g., 'PROJ-123' for Jira, 'TEAM-123' for Linear, GID for Asana, item ID for Monday)",
        ),
      apiToken: z
        .string()
        .describe("API token for the PM tool (sensitive — not stored after this request)"),
      domain: z
        .string()
        .optional()
        .describe("Required for Jira (e.g., 'mycompany.atlassian.net') and Monday (account slug)"),
      email: z.string().optional().describe("Required for Jira (email for Basic Auth)"),
    },
    async (args: {
      provider: "jira" | "linear" | "asana" | "monday";
      issueKey: string;
      apiToken: string;
      domain?: string;
      email?: string;
    }) => {
      requireScope("bounties:create");
      const authUser = getAuthUser();
      if (!authUser?.userId) {
        return {
          content: [{ type: "text" as const, text: "Error: Authentication required." }],
          isError: true,
        };
      }

      try {
        const result = await callConvex<{ workItem: WorkItem }>("/api/mcp/work-items/import", {
          provider: args.provider,
          issueKey: args.issueKey,
          apiToken: args.apiToken,
          domain: args.domain,
          email: args.email,
        });

        const workItem = result.workItem;

        let text = `# Work Item Imported\n\n`;
        text += `**Provider:** ${args.provider}\n`;
        text += `**ID:** ${workItem.externalId}\n`;
        text += `**Title:** ${workItem.title}\n`;
        text += `**Status:** ${workItem.status}\n`;
        if (workItem.priority) text += `**Priority:** ${workItem.priority}\n`;
        if (workItem.estimate) text += `**Estimate:** ${workItem.estimate} points\n`;
        if (workItem.labels.length > 0) text += `**Labels:** ${workItem.labels.join(", ")}\n`;
        text += `**URL:** ${workItem.url}\n\n`;
        text += `## Description\n\n${workItem.description || "No description"}\n`;
        if (workItem.acceptanceCriteria) {
          text += `\n## Acceptance Criteria\n\n${workItem.acceptanceCriteria}\n`;
        }
        text += `\n---\nUse \`create_bounty\` with this information to create a bounty. `;
        text += `Pass \`pmIssueKey: "${workItem.externalId}"\` and \`pmProvider: "${args.provider}"\` for traceability.`;

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to import work item";
        return {
          content: [{ type: "text" as const, text: `Failed to import work item: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
