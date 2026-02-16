import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

export function registerWorkspaceReadFile(server: McpServer): void {
  registerTool(
    server,
    "workspace_read_file",
    "Read a file from your workspace. Paths relative to /workspace.",
    {
      bountyId: z.string().describe("The bounty ID you have claimed"),
      path: z.string().describe("File path relative to /workspace"),
      offset: z
        .string()
        .optional()
        .describe("Start from line N (1-based)"),
      limit: z
        .string()
        .optional()
        .describe("Max lines to return (default 2000, max 5000)"),
    },
    async (args) => {
      requireScope("workspace:read");
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

      // SECURITY (W3): Defense-in-depth path validation at MCP layer
      // (worker also validates, but reject obvious traversal early)
      const normalizedPath = args.path.replace(/\\/g, "/");
      if (normalizedPath.includes("..") && !normalizedPath.startsWith("/workspace/")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Path traversal not allowed. Paths must resolve within /workspace/.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await callWorker<{
          content: string;
          path: string;
          totalLines: number;
          startLine: number;
          linesReturned: number;
          isBinary: boolean;
        }>(ws.workerHost, "/api/workspace/read-file", {
          workspaceId: ws.workspaceId,
          path: args.path,
          offset: args.offset ? parseInt(args.offset, 10) : undefined,
          limit: args.limit ? parseInt(args.limit, 10) : undefined,
        });

        if (result.isBinary) {
          return {
            content: [
              {
                type: "text" as const,
                text: `\`${result.path}\` is a binary file and cannot be displayed.`,
              },
            ],
          };
        }

        // Format with line numbers
        const startLine = result.startLine || 1;
        const lines = result.content.split("\n");
        const numbered = lines
          .map((line, i) => `${String(startLine + i).padStart(5)}  ${line}`)
          .join("\n");

        const header =
          `**${result.path}** (${result.totalLines} lines total, showing ${startLine}-${startLine + result.linesReturned - 1})`;

        return {
          content: [
            {
              type: "text" as const,
              text: `${header}\n\`\`\`\n${numbered}\n\`\`\``,
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "File read failed";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
