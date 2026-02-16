import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

export function registerWorkspaceBatchWrite(server: McpServer): void {
  registerTool(
    server,
    "workspace_batch_write",
    "Write or create multiple files in your workspace in a single request. " +
      "Max 10 files, 1MB total content. Paths relative to /workspace.",
    {
      bountyId: z.string().describe("The bounty ID you have claimed"),
      files: z
        .array(
          z.object({
            path: z.string().describe("File path relative to /workspace"),
            content: z.string().describe("File content"),
          }),
        )
        .min(1)
        .max(10)
        .describe("Array of files to write (max 10)"),
    },
    async (args) => {
      // SECURITY (H4): Scope enforcement
      requireScope("workspace:write");
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

      // SECURITY (W3): Defense-in-depth path traversal check on each path
      for (const f of args.files) {
        const norm = f.path.replace(/\\/g, "/");
        if (norm.includes("..") && !norm.startsWith("/workspace/")) {
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
      }

      // Check total content size at MCP layer
      const totalBytes = args.files.reduce(
        (acc: number, f: { content: string }) =>
          acc + Buffer.byteLength(f.content, "utf-8"),
        0,
      );
      if (totalBytes > 1024 * 1024) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Total content too large (${(totalBytes / 1024).toFixed(0)}KB > 1024KB max).`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await callWorker<{
          results: Array<{
            path: string;
            bytesWritten: number;
            error?: string;
          }>;
        }>(ws.workerHost, "/api/workspace/batch-write", {
          workspaceId: ws.workspaceId,
          files: args.files,
        });

        const lines = result.results.map((r) =>
          r.error
            ? `- \`${r.path}\` — ERROR: ${r.error}`
            : `- \`${r.path}\` — ${r.bytesWritten} bytes written`,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Batch write complete:\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Batch write failed";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
