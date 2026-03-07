/**
 * Repo Mapper — builds three core data structures from parsed symbols:
 * 1. Symbol Table: all symbols with qualified names, types, signatures
 * 2. Dependency Graph: file nodes + import edges
 * 3. Repo Map Text: compact Aider-style format for LLM context
 */

import type { FileParseResult } from "./treeSitter";

export interface SymbolTableEntry {
  qualifiedName: string;
  name: string;
  type: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  exported: boolean;
  parentScope: string | null;
}

export interface DependencyNode {
  filePath: string;
  exports: string[];
  importCount: number;
  dependencyCount: number;
}

export interface DependencyEdge {
  from: string; // importer file path
  to: string; // imported module/file path
  importedNames: string[];
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export interface RepoMapResult {
  symbolTable: SymbolTableEntry[];
  dependencyGraph: DependencyGraph;
  repoMapText: string;
}

/**
 * Default token budget for the repo map text.
 * ~4 chars per token, so 6000 tokens ≈ 24000 chars.
 */
const DEFAULT_TOKEN_BUDGET = 6000;
const CHARS_PER_TOKEN = 4;

/**
 * Build all three data structures from parsed file results.
 */
export function buildRepoMap(
  parseResults: FileParseResult[],
  tokenBudget: number = DEFAULT_TOKEN_BUDGET
): RepoMapResult {
  const symbolTable = buildSymbolTable(parseResults);
  const dependencyGraph = buildDependencyGraph(parseResults);
  const repoMapText = buildRepoMapText(
    parseResults,
    dependencyGraph,
    tokenBudget
  );

  return { symbolTable, dependencyGraph, repoMapText };
}

/**
 * Build a flat symbol table from all parsed files.
 */
function buildSymbolTable(
  parseResults: FileParseResult[]
): SymbolTableEntry[] {
  const entries: SymbolTableEntry[] = [];

  for (const result of parseResults) {
    for (const symbol of result.symbols) {
      const qualifiedName = symbol.parentScope
        ? `${result.filePath}:${symbol.parentScope}.${symbol.name}`
        : `${result.filePath}:${symbol.name}`;

      entries.push({
        qualifiedName,
        name: symbol.name,
        type: symbol.type,
        filePath: result.filePath,
        language: result.language,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        signature: symbol.signature,
        exported: symbol.exported,
        parentScope: symbol.parentScope,
      });
    }
  }

  return entries;
}

/**
 * Build a dependency graph from import/export data.
 */
function buildDependencyGraph(
  parseResults: FileParseResult[]
): DependencyGraph {
  const nodeMap = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];

  // Initialize nodes
  for (const result of parseResults) {
    nodeMap.set(result.filePath, {
      filePath: result.filePath,
      exports: result.exports,
      importCount: 0,
      dependencyCount: result.imports.length,
    });
  }

  // Build edges from imports
  for (const result of parseResults) {
    for (const imp of result.imports) {
      const resolvedPath = resolveImportPath(
        result.filePath,
        imp.source,
        Array.from(nodeMap.keys())
      );

      edges.push({
        from: result.filePath,
        to: resolvedPath || imp.source,
        importedNames: imp.importedNames,
      });

      // Increment import count for the target
      if (resolvedPath && nodeMap.has(resolvedPath)) {
        const node = nodeMap.get(resolvedPath)!;
        node.importCount++;
      }
    }
  }

  return {
    nodes: Array.from(nodeMap.values()),
    edges,
  };
}

/**
 * Resolve a relative import path to an actual file in the repo.
 */
function resolveImportPath(
  fromFile: string,
  importSource: string,
  allFiles: string[]
): string | null {
  // Skip package imports (not relative)
  if (!importSource.startsWith(".") && !importSource.startsWith("/")) {
    return null;
  }

  // Get the directory of the importing file
  const fromDir = fromFile.split("/").slice(0, -1).join("/");
  let resolved = importSource;

  if (importSource.startsWith("./")) {
    resolved = fromDir ? `${fromDir}/${importSource.slice(2)}` : importSource.slice(2);
  } else if (importSource.startsWith("../")) {
    const parts = fromDir.split("/");
    let remaining = importSource;
    while (remaining.startsWith("../")) {
      parts.pop();
      remaining = remaining.slice(3);
    }
    resolved = parts.length > 0 ? `${parts.join("/")}/${remaining}` : remaining;
  }

  // Try exact match and common extensions
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (allFiles.includes(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Build the Aider-style compact repo map text.
 * Files are ranked by dependency importance and only exported symbols are shown.
 */
function buildRepoMapText(
  parseResults: FileParseResult[],
  depGraph: DependencyGraph,
  tokenBudget: number
): string {
  const charBudget = tokenBudget * CHARS_PER_TOKEN;

  // Rank files: high import count (many files depend on them) first,
  // then by export count, then alphabetically
  const fileRanking = new Map<string, number>();
  for (const node of depGraph.nodes) {
    // Score: imported by others (high value) + has exports
    fileRanking.set(
      node.filePath,
      node.importCount * 10 + node.exports.length * 2
    );
  }

  const sortedResults = [...parseResults].sort((a, b) => {
    const scoreA = fileRanking.get(a.filePath) || 0;
    const scoreB = fileRanking.get(b.filePath) || 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.filePath.localeCompare(b.filePath);
  });

  const lines: string[] = [];
  let currentChars = 0;

  for (const result of sortedResults) {
    if (currentChars >= charBudget) break;

    const exportedSymbols = result.symbols.filter((s) => s.exported);
    if (exportedSymbols.length === 0 && result.symbols.length === 0) continue;

    const fileHeader = `${result.filePath}:\n`;

    if (currentChars + fileHeader.length > charBudget) {
      break;
    }

    // If we don't have room for symbols, just show the file path
    const symbolLines = (
      exportedSymbols.length > 0 ? exportedSymbols : result.symbols.slice(0, 5)
    )
      .map((s) => `  ${s.signature || s.name}`)
      .join("\n");

    const fullEntry = fileHeader + symbolLines + "\n";

    if (currentChars + fullEntry.length <= charBudget) {
      lines.push(fullEntry);
      currentChars += fullEntry.length;
    } else if (currentChars + fileHeader.length <= charBudget) {
      // Just show the file path if we can't fit symbols
      lines.push(fileHeader);
      currentChars += fileHeader.length;
    }
  }

  return lines.join("");
}

/**
 * Serialize the symbol table to JSON string.
 */
export function serializeSymbolTable(table: SymbolTableEntry[]): string {
  return JSON.stringify(table);
}

/**
 * Serialize the dependency graph to JSON string.
 */
export function serializeDependencyGraph(graph: DependencyGraph): string {
  return JSON.stringify(graph);
}
