import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

interface GrepMatch {
  file: string;
  line: number;
  text: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

interface GrepResult {
  matches: GrepMatch[];
  fileMatches?: Array<{ file: string; count: number }>;
  totalMatches: number;
  truncated: boolean;
  outputMode: string;
}

function parseContextLines(raw?: string): number {
  if (!raw) {
    return 0;
  }
  return Math.min(Number.parseInt(raw, 10), 10);
}

function renderWorkspaceUnavailable(ws: {
  found: boolean;
  status?: string;
}) {
  return {
    content: [
      {
        type: "text" as const,
        text: ws.found
          ? `Workspace is not ready (status: ${ws.status ?? "unknown"}).`
          : "No workspace found. Claim the bounty first.",
      },
    ],
    isError: true,
  };
}

function renderFilesWithMatches(pattern: string, result: GrepResult) {
  if (!result.fileMatches || result.fileMatches.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No files found matching pattern: ${pattern}`,
        },
      ],
    };
  }

  const listing = result.fileMatches.map((fileMatch) => `  ${fileMatch.file}`).join("\n");
  const footer = result.truncated
    ? `\n\n(${result.fileMatches.length} files shown, results truncated)`
    : `\n\n(${result.fileMatches.length} files)`;

  return {
    content: [
      {
        type: "text" as const,
        text: `**Files matching \`${pattern}\`:**\n${listing}${footer}`,
      },
    ],
  };
}

function renderCountMode(pattern: string, result: GrepResult) {
  if (!result.fileMatches || result.fileMatches.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No matches found for pattern: ${pattern}`,
        },
      ],
    };
  }

  const listing = result.fileMatches.map((fileMatch) => `  ${fileMatch.file}: ${fileMatch.count}`).join("\n");
  return {
    content: [
      {
        type: "text" as const,
        text: `**Match counts for \`${pattern}\`:**\n${listing}\n\n(${result.totalMatches} total matches)`,
      },
    ],
  };
}

function formatMatchBlock(matches: GrepMatch[]): string {
  const lines: string[] = [];
  for (const match of matches) {
    if (match.contextBefore && match.contextBefore.length > 0) {
      for (const contextLine of match.contextBefore) {
        lines.push(`       ${contextLine}`);
      }
    }
    lines.push(`  ${String(match.line).padStart(5)}  ${match.text}`);
    if (match.contextAfter && match.contextAfter.length > 0) {
      for (const contextLine of match.contextAfter) {
        lines.push(`       ${contextLine}`);
      }
    }
  }
  return lines.join("\n");
}

function renderContentMode(pattern: string, result: GrepResult) {
  if (result.matches.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No matches found for pattern: ${pattern}`,
        },
      ],
    };
  }

  const byFile = new Map<string, GrepMatch[]>();
  for (const match of result.matches) {
    const existing = byFile.get(match.file) ?? [];
    existing.push(match);
    byFile.set(match.file, existing);
  }

  const parts: string[] = [];
  for (const [file, fileMatches] of byFile) {
    parts.push(`**${file}**\n${formatMatchBlock(fileMatches)}`);
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
}

function renderSearchResult(pattern: string, result: GrepResult) {
  if (result.outputMode === "files_with_matches") {
    return renderFilesWithMatches(pattern, result);
  }
  if (result.outputMode === "count") {
    return renderCountMode(pattern, result);
  }
  return renderContentMode(pattern, result);
}

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
        return renderWorkspaceUnavailable(ws);
      }

      try {
        const contextLines = parseContextLines(args.contextLines);

        const result = await callWorker<GrepResult>(ws.workerHost, "/api/workspace/grep", {
          workspaceId: ws.workspaceId,
          pattern: args.pattern,
          glob: args.glob,
          path: args.path,
          caseSensitive: args.caseSensitive !== "false",
          contextLines,
          outputMode: args.outputMode ?? "content",
        });
        return renderSearchResult(args.pattern, result);
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
