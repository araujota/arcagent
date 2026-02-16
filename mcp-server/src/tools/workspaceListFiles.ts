import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

export function registerWorkspaceListFiles(server: McpServer): void {
  registerTool(
    server,
    "workspace_list_files",
    "List files in your workspace with optional glob filter. " +
      "Excludes .git and node_modules by default. " +
      "Faster and more structured than using workspace_exec with find.",
    {
      bountyId: z.string().describe("The bounty ID you have claimed"),
      glob: z
        .string()
        .optional()
        .describe("File name glob (e.g. '*.ts', '*.test.*'). Only alphanumeric, *, ?, /, -, _, ., [], {} allowed."),
      maxDepth: z
        .string()
        .optional()
        .describe("Max directory depth (default 10, max 20)"),
      maxResults: z
        .string()
        .optional()
        .describe("Max files to return (default 500, max 500)"),
    },
    async (args) => {
      // SECURITY (H4): Scope enforcement
      requireScope("workspace:read");
      // SECURITY (C1): Identity from auth context
      const user = requireAuthUser();

      const ws = await getWorkspaceForAgent(user.userId, args.bountyId);
      if (!ws.found || ws.status !== "ready") {
        return {
          content: [
            {
              type: "text" as const,
              text: ws.found
                ? `Workspace is not ready (status: ${ws.status}).`
                : "No workspace found. Claim the bounty first.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await callWorker<{
          files: string[];
          totalCount: number;
          truncated: boolean;
        }>(ws.workerHost, "/api/workspace/list-files", {
          workspaceId: ws.workspaceId,
          glob: args.glob,
          maxDepth: args.maxDepth ? parseInt(args.maxDepth, 10) : undefined,
          maxResults: args.maxResults ? parseInt(args.maxResults, 10) : undefined,
        });

        if (result.files.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: args.glob
                  ? `No files found matching glob: ${args.glob}`
                  : "No files found in workspace.",
              },
            ],
          };
        }

        const listing = result.files.map((f) => `  ${f}`).join("\n");
        const footer = result.truncated
          ? `\n\n(${result.totalCount} files shown, results truncated)`
          : `\n\n(${result.totalCount} files)`;

        return {
          content: [
            {
              type: "text" as const,
              text: `**Workspace files:**\n${listing}${footer}`,
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "List files failed";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
