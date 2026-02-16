import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

export function registerWorkspaceSearch(server: McpServer): void {
  registerTool(
    server,
    "workspace_search",
    "Search for a pattern across files in your workspace using grep. " +
      "Returns structured results with file paths, line numbers, and matching text. " +
      "Much faster and more reliable than running grep via workspace_exec.",
    {
      bountyId: z.string().describe("The bounty ID you have claimed"),
      pattern: z
        .string()
        .max(500)
        .describe("Search pattern (regular expression supported)"),
      glob: z
        .string()
        .optional()
        .describe("File glob filter (e.g. '*.ts', '*.py'). Only alphanumeric, *, ?, /, -, _, ., [], {} allowed."),
      maxResults: z
        .string()
        .optional()
        .describe("Maximum number of matches (default 100, max 200)"),
      caseSensitive: z
        .string()
        .optional()
        .describe("Case sensitive search: 'true' or 'false' (default 'true')"),
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
          matches: Array<{
            file: string;
            line: number;
            text: string;
          }>;
          totalMatches: number;
          truncated: boolean;
        }>(ws.workerHost, "/api/workspace/search", {
          workspaceId: ws.workspaceId,
          pattern: args.pattern,
          glob: args.glob,
          maxResults: args.maxResults ? parseInt(args.maxResults, 10) : undefined,
          caseSensitive: args.caseSensitive !== "false",
        });

        if (result.matches.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No matches found for pattern: ${args.pattern}`,
              },
            ],
          };
        }

        // Group by file for readability
        const byFile = new Map<string, Array<{ line: number; text: string }>>();
        for (const m of result.matches) {
          const arr = byFile.get(m.file) ?? [];
          arr.push({ line: m.line, text: m.text });
          byFile.set(m.file, arr);
        }

        const parts: string[] = [];
        for (const [file, matches] of byFile) {
          const lines = matches
            .map((m) => `  ${String(m.line).padStart(5)}  ${m.text}`)
            .join("\n");
          parts.push(`**${file}**\n${lines}`);
        }

        const header = result.truncated
          ? `Found ${result.totalMatches}+ matches (truncated):`
          : `Found ${result.totalMatches} matches:`;

        return {
          content: [
            {
              type: "text" as const,
              text: `${header}\n\n${parts.join("\n\n")}`,
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Search failed";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
