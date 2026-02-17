import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

export function registerWorkspaceGlob(server: McpServer): void {
  registerTool(
    server,
    "workspace_glob",
    "Find files by glob pattern in your workspace. Returns matching file paths sorted by modification " +
      "time (most recently modified first). Useful for discovering project structure, finding files by " +
      "extension, or locating specific file names. Excludes .git and node_modules by default.",
    {
      bountyId: z.string().describe("The bounty ID you have claimed"),
      pattern: z
        .string()
        .describe("Glob pattern to match (e.g. '**/*.ts', 'src/**/*.test.*', '*.json')"),
      path: z
        .string()
        .optional()
        .describe("Subdirectory to search in, relative to /workspace (default: workspace root)"),
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
        }>(ws.workerHost, "/api/workspace/glob", {
          workspaceId: ws.workspaceId,
          pattern: args.pattern,
          path: args.path,
        });

        if (result.files.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No files found matching pattern: ${args.pattern}`,
              },
            ],
          };
        }

        const listing = result.files.map((f) => `  ${f}`).join("\n");
        const footer = result.truncated
          ? `\n\n(showing ${result.files.length} of ${result.totalCount}+ matches, sorted by mtime)`
          : `\n\n(${result.totalCount} files, sorted by mtime)`;

        return {
          content: [
            {
              type: "text" as const,
              text: `**Matching files:**\n${listing}${footer}`,
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Glob search failed";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
