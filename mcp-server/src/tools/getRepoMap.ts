import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { ConvexBountyDetails } from "../lib/types";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

const MAX_SYMBOLS = 200;
const MAX_DIR_DEPTH = 2;

interface RepoMapPayload {
  repoMapText: string;
  symbolTableJson: string;
  dependencyGraphJson: string;
}

/**
 * Filter file tree text to only include paths within relevantPaths,
 * capped at MAX_DIR_DEPTH levels deep from each relevant root.
 */
function normalizeTreeLine(line: string): string {
  return line.replace(/^[\s│├└─]+/, "").trim();
}

function includesPathPrefix(path: string, root: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return (
    path.startsWith(normalizedRoot) ||
    path.startsWith(root) ||
    normalizedRoot.startsWith(`${path}/`) ||
    root === path
  );
}

function findMatchedRoot(path: string, relevantPaths: string[]): string | null {
  return relevantPaths.find((root) => path.startsWith(root) || path.startsWith(`${root}/`)) ?? null;
}

function isWithinScopedDepth(path: string, matchedRoot: string): boolean {
  const relative = path.slice(matchedRoot.length).replace(/^\//, "");
  const depth = relative ? relative.split("/").length : 0;
  return depth <= MAX_DIR_DEPTH;
}

function filterFileTree(
  repoMapText: string,
  relevantPaths: string[],
): string {
  const lines = repoMapText.split("\n");
  const filtered: string[] = [];

  for (const line of lines) {
    const trimmed = normalizeTreeLine(line);
    if (!trimmed) continue;

    const matches = relevantPaths.some((root) => includesPathPrefix(trimmed, root));
    if (!matches) continue;

    const matchedRoot = findMatchedRoot(trimmed, relevantPaths);
    if (!matchedRoot || isWithinScopedDepth(trimmed, matchedRoot)) {
      // Include matched files and parent paths leading to a match.
      filtered.push(line);
    }
  }

  return filtered.length > 0 ? filtered.join("\n") : repoMapText;
}

/**
 * Filter symbols to only those whose file path falls within relevantPaths.
 * Caps at MAX_SYMBOLS entries.
 */
function filterSymbols(
  symbols: Array<{ file?: string; path?: string; [key: string]: unknown }>,
  relevantPaths: string[],
): typeof symbols {
  const filtered = symbols.filter((sym) => {
    const filePath = sym.file || sym.path || "";
    return relevantPaths.some(
      (rp) => filePath.startsWith(rp) || filePath.startsWith(rp + "/"),
    );
  });

  return filtered.slice(0, MAX_SYMBOLS);
}

/**
 * Filter dependency graph to only entries where the source file
 * falls within relevantPaths.
 */
function filterDeps(
  deps: Record<string, unknown>,
  relevantPaths: string[],
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(deps)) {
    if (relevantPaths.some((rp) => key.startsWith(rp) || key.startsWith(rp + "/"))) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function renderSymbolSection(
  repoMap: RepoMapPayload,
  hasScope: boolean,
  relevantPaths: string[],
): string {
  try {
    let symbols = JSON.parse(repoMap.symbolTableJson);
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return "";
    }

    symbols = hasScope
      ? filterSymbols(symbols, relevantPaths)
      : symbols.slice(0, MAX_SYMBOLS);
    const symbolJson = JSON.stringify(symbols, null, 2).slice(0, 5000);
    return `## Symbol Table (${symbols.length} symbols${hasScope ? ", scoped" : ""})\n\`\`\`json\n${symbolJson}\n\`\`\`\n\n`;
  } catch {
    return "> _Note: Symbol table could not be loaded for this repository._\n\n";
  }
}

function renderDependencySection(
  repoMap: RepoMapPayload,
  hasScope: boolean,
  relevantPaths: string[],
): string {
  try {
    let deps = JSON.parse(repoMap.dependencyGraphJson);
    if (!deps || typeof deps !== "object") return "";

    if (hasScope) {
      deps = filterDeps(deps, relevantPaths);
    }
    const keys = Object.keys(deps);
    if (keys.length === 0) return "";

    const depJson = JSON.stringify(deps, null, 2).slice(0, 3000);
    return `## Dependency Graph\n\`\`\`json\n${depJson}\n\`\`\`\n`;
  } catch {
    // dependencyGraphJson may not be valid JSON.
    return "";
  }
}

export function registerGetRepoMap(server: McpServer): void {
  registerTool(
    server,
    "get_repo_map",
    "Get the repository structure, symbol table, and dependency graph for a bounty's codebase. Results are scoped to the bounty's relevant paths if configured.",
    {
      bountyId: z.string().describe("The bounty ID"),
    },
    async (args: { bountyId: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:read");
      const result = await callConvex<{ bounty: ConvexBountyDetails }>(
        "/api/mcp/bounties/get",
        { bountyId: args.bountyId },
      );

      const repoMap = result.bounty.repoMap;
      const relevantPaths = result.bounty.relevantPaths ?? [];

      if (!repoMap) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No repository map available for this bounty. The repository may not have been indexed yet.",
            },
          ],
        };
      }

      const hasScope = relevantPaths.length > 0;

      // File tree — optionally scoped
      const fileTree = hasScope
        ? filterFileTree(repoMap.repoMapText, relevantPaths)
        : repoMap.repoMapText;

      const sections: string[] = [
        "# Repository Map",
        "",
        ...(hasScope ? [`> Scoped to: ${relevantPaths.join(", ")}`, ""] : []),
        `## File Structure\n\`\`\`\n${fileTree}\n\`\`\`\n`,
        renderSymbolSection(repoMap as RepoMapPayload, hasScope, relevantPaths),
        renderDependencySection(repoMap as RepoMapPayload, hasScope, relevantPaths),
      ];
      const text = sections.filter(Boolean).join("\n");

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
