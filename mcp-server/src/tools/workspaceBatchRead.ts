import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

export function registerWorkspaceBatchRead(server: McpServer): void {
  registerTool(
    server,
    "workspace_batch_read",
    "Read multiple files from your workspace in a single request. Much faster than reading files one by one. " +
      "Max 10 files per batch. Paths relative to /workspace.",
    {
      bountyId: z.string().describe("The bounty ID you have claimed"),
      paths: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe("Array of file paths relative to /workspace (max 10)"),
      maxLinesPerFile: z
        .string()
        .optional()
        .describe("Max lines per file (default 1000, max 1000)"),
    },
    async (args) => {
      // SECURITY (H4): Scope enforcement
      requireScope("workspace:read");
      // SECURITY (C1): Identity from auth context, never from parameters
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
      for (const p of args.paths) {
        const norm = p.replace(/\\/g, "/");
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

      try {
        const result = await callWorker<{
          files: Array<{
            path: string;
            content?: string;
            totalLines?: number;
            isBinary?: boolean;
            error?: string;
          }>;
        }>(ws.workerHost, "/api/workspace/batch-read", {
          workspaceId: ws.workspaceId,
          paths: args.paths,
          maxLinesPerFile: args.maxLinesPerFile
            ? parseInt(args.maxLinesPerFile, 10)
            : undefined,
        });

        const parts = result.files.map((f) => {
          if (f.error) {
            return `**${f.path}** — ${f.error}`;
          }
          if (f.isBinary) {
            return `**${f.path}** — binary file, cannot display`;
          }
          const lines = (f.content ?? "").split("\n");
          const numbered = lines
            .map((line, i) => `${String(i + 1).padStart(5)}  ${line}`)
            .join("\n");
          return `**${f.path}** (${f.totalLines ?? 0} lines total)\n\`\`\`\n${numbered}\n\`\`\``;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: parts.join("\n\n---\n\n"),
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Batch read failed";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
