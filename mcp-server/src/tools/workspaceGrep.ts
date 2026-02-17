import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

export function registerWorkspaceGrep(server: McpServer): void {
  registerTool(
    server,
    "workspace_grep",
    "Search for a regex pattern across files in your workspace using ripgrep. " +
      "Returns structured results grouped by file with line numbers and context. " +
      "Supports glob filtering, case sensitivity control, and context lines. " +
      "Much faster than running grep via workspace_exec.",
    {
      bountyId: z.string().describe("The bounty ID you have claimed"),
      pattern: z
        .string()
        .max(500)
        .describe("Search pattern (regex supported)"),
      glob: z
        .string()
        .optional()
        .describe("File glob filter (e.g. '*.ts', '*.{js,jsx}'). Only alphanumeric, *, ?, /, -, _, ., [], {} allowed."),
      path: z
        .string()
        .optional()
        .describe("Subdirectory to search in, relative to /workspace (default: workspace root)"),
      caseSensitive: z
        .string()
        .optional()
        .describe("Case sensitive search: 'true' or 'false' (default 'true')"),
      contextLines: z
        .string()
        .optional()
        .describe("Lines of context before and after each match (default 0, max 10)"),
      outputMode: z
        .string()
        .optional()
        .describe("Output mode: 'content' (matching lines), 'files_with_matches' (file paths only), 'count' (match counts per file). Default 'content'."),
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
        const contextLines = args.contextLines
          ? Math.min(parseInt(args.contextLines, 10), 10)
          : 0;

        const result = await callWorker<{
          matches: Array<{
            file: string;
            line: number;
            text: string;
            contextBefore?: string[];
            contextAfter?: string[];
          }>;
          fileMatches?: Array<{ file: string; count: number }>;
          totalMatches: number;
          truncated: boolean;
          outputMode: string;
        }>(ws.workerHost, "/api/workspace/grep", {
          workspaceId: ws.workspaceId,
          pattern: args.pattern,
          glob: args.glob,
          path: args.path,
          caseSensitive: args.caseSensitive !== "false",
          contextLines,
          outputMode: args.outputMode ?? "content",
        });

        // Handle files_with_matches mode
        if (result.outputMode === "files_with_matches" && result.fileMatches) {
          if (result.fileMatches.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No files found matching pattern: ${args.pattern}`,
                },
              ],
            };
          }

          const listing = result.fileMatches
            .map((f) => `  ${f.file}`)
            .join("\n");
          const footer = result.truncated
            ? `\n\n(${result.fileMatches.length} files shown, results truncated)`
            : `\n\n(${result.fileMatches.length} files)`;

          return {
            content: [
              {
                type: "text" as const,
                text: `**Files matching \`${args.pattern}\`:**\n${listing}${footer}`,
              },
            ],
          };
        }

        // Handle count mode
        if (result.outputMode === "count" && result.fileMatches) {
          if (result.fileMatches.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No matches found for pattern: ${args.pattern}`,
                },
              ],
            };
          }

          const listing = result.fileMatches
            .map((f) => `  ${f.file}: ${f.count}`)
            .join("\n");

          return {
            content: [
              {
                type: "text" as const,
                text: `**Match counts for \`${args.pattern}\`:**\n${listing}\n\n(${result.totalMatches} total matches)`,
              },
            ],
          };
        }

        // Default: content mode
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
        const byFile = new Map<
          string,
          Array<{
            line: number;
            text: string;
            contextBefore?: string[];
            contextAfter?: string[];
          }>
        >();
        for (const m of result.matches) {
          const arr = byFile.get(m.file) ?? [];
          arr.push({
            line: m.line,
            text: m.text,
            contextBefore: m.contextBefore,
            contextAfter: m.contextAfter,
          });
          byFile.set(m.file, arr);
        }

        const parts: string[] = [];
        for (const [file, matches] of byFile) {
          const lines: string[] = [];
          for (const m of matches) {
            if (m.contextBefore && m.contextBefore.length > 0) {
              for (const ctx of m.contextBefore) {
                lines.push(`       ${ctx}`);
              }
            }
            lines.push(`  ${String(m.line).padStart(5)}  ${m.text}`);
            if (m.contextAfter && m.contextAfter.length > 0) {
              for (const ctx of m.contextAfter) {
                lines.push(`       ${ctx}`);
              }
            }
          }
          parts.push(`**${file}**\n${lines.join("\n")}`);
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
          err instanceof Error ? err.message : "Grep search failed";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
