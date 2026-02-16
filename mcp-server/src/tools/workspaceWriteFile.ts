import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

export function registerWorkspaceWriteFile(server: McpServer): void {
  registerTool(
    server,
    "workspace_write_file",
    "Write or create a file in your workspace. Creates parent directories. Paths relative to /workspace.",
    {
      bountyId: z.string().describe("The bounty ID you have claimed"),
      path: z.string().describe("File path relative to /workspace"),
      content: z.string().describe("File content (max 1MB)"),
    },
    async (args) => {
      requireScope("workspace:write");
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

      // Check content size
      const sizeBytes = Buffer.byteLength(args.content, "utf-8");
      if (sizeBytes > 1024 * 1024) {
        return {
          content: [
            {
              type: "text" as const,
              text: `File content too large (${(sizeBytes / 1024).toFixed(0)}KB > 1024KB max).`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await callWorker<{
          bytesWritten: number;
          path: string;
        }>(ws.workerHost, "/api/workspace/write-file", {
          workspaceId: ws.workspaceId,
          path: args.path,
          content: args.content,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Written ${result.bytesWritten} bytes to \`${result.path}\``,
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "File write failed";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
