/**
 * AST-aware code chunker (cAST method).
 * Splits source files into semantic chunks suitable for embedding.
 *
 * Strategy:
 * - Each top-level function → one chunk
 * - Each class → one chunk (split if >200 lines)
 * - Module-level code → "module preamble" chunk
 * - Type/interface groups → "types" chunk per file
 * - Max chunk: ~1500 tokens (~6000 chars)
 * - Min chunk: 50 tokens (~200 chars) — merge tiny ones
 */

import type { ExtractedSymbol, FileParseResult } from "./treeSitter";

export interface CodeChunk {
  filePath: string;
  symbolName: string;
  symbolType:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "method"
    | "module"
    | "enum"
    | "constant";
  language: string;
  content: string;
  startLine: number;
  endLine: number;
  parentScope: string | null;
  signature: string | null;
}

const MAX_CHUNK_CHARS = 6000; // ~1500 tokens
const MIN_CHUNK_CHARS = 200; // ~50 tokens
const CLASS_SPLIT_THRESHOLD = 200; // lines

function appendChunkWithSplit(chunks: CodeChunk[], chunk: CodeChunk): void {
  if (chunk.content.length <= MAX_CHUNK_CHARS) {
    chunks.push(chunk);
    return;
  }
  chunks.push(...splitLargeChunk(chunk));
}

function classHeaderChunk(symbol: ExtractedSymbol, filePath: string, language: string): CodeChunk {
  const headerLines = symbol.content.split("\n").slice(0, 10);
  return {
    filePath,
    symbolName: symbol.name,
    symbolType: "class",
    language,
    content: headerLines.join("\n") + "\n  // ... (methods below)",
    startLine: symbol.startLine,
    endLine: symbol.startLine + 10,
    parentScope: null,
    signature: symbol.signature,
  };
}

function appendFunctionChunks(
  chunks: CodeChunk[],
  symbols: ExtractedSymbol[],
  filePath: string,
  language: string,
): void {
  for (const symbol of symbols) {
    if (symbol.parentScope) continue;
    appendChunkWithSplit(chunks, symbolToChunk(symbol, filePath, language));
  }
}

function appendClassChunks(
  chunks: CodeChunk[],
  classes: ExtractedSymbol[],
  symbols: ExtractedSymbol[],
  filePath: string,
  language: string,
): void {
  for (const cls of classes) {
    const lineCount = cls.endLine - cls.startLine;
    if (lineCount <= CLASS_SPLIT_THRESHOLD) {
      appendChunkWithSplit(chunks, symbolToChunk(cls, filePath, language));
      continue;
    }

    chunks.push(classHeaderChunk(cls, filePath, language));
    const methods = symbols.filter(
      (symbol) => symbol.type === "method" && symbol.parentScope === cls.name,
    );
    for (const method of methods) {
      chunks.push(symbolToChunk(method, filePath, language));
    }
  }
}

function isTinyChunk(chunk: CodeChunk): boolean {
  return chunk.content.length < MIN_CHUNK_CHARS;
}

function canMergeChunks(left: CodeChunk, right: CodeChunk): boolean {
  return left.filePath === right.filePath && left.content.length + right.content.length <= MAX_CHUNK_CHARS;
}

function mergeChunkPair(left: CodeChunk, right: CodeChunk): CodeChunk {
  return {
    ...left,
    symbolName: `${left.symbolName}+${right.symbolName}`,
    content: `${left.content}\n\n${right.content}`,
    endLine: right.endLine,
  };
}

function foldChunkIntoMergeState(
  merged: CodeChunk[],
  pending: CodeChunk | null,
  chunk: CodeChunk,
): CodeChunk | null {
  if (!pending) {
    if (isTinyChunk(chunk)) return chunk;
    merged.push(chunk);
    return null;
  }

  if (!canMergeChunks(pending, chunk)) {
    merged.push(pending);
    if (isTinyChunk(chunk)) return chunk;
    merged.push(chunk);
    return null;
  }

  const mergedPending = mergeChunkPair(pending, chunk);
  if (isTinyChunk(mergedPending)) return mergedPending;
  merged.push(mergedPending);
  return null;
}

/**
 * Chunk a single file's parse results into semantic code chunks.
 */
export function chunkFile(parseResult: FileParseResult): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const { filePath, language, symbols } = parseResult;

  if (symbols.length === 0) {
    // If no symbols extracted, treat entire file as one module chunk
    return [];
  }

  // Separate symbols by type
  const functions = symbols.filter(
    (s) => s.type === "function" || s.type === "method"
  );
  const classes = symbols.filter((s) => s.type === "class");
  const types = symbols.filter(
    (s) =>
      s.type === "interface" || s.type === "type" || s.type === "enum"
  );
  const constants = symbols.filter((s) => s.type === "constant");

  appendFunctionChunks(chunks, functions, filePath, language);
  appendClassChunks(chunks, classes, symbols, filePath, language);

  // Process types/interfaces — group small ones together
  if (types.length > 0) {
    const typeChunks = groupSmallSymbols(types, filePath, language, "types");
    chunks.push(...typeChunks);
  }

  // Process constants — group together as module preamble
  if (constants.length > 0) {
    const constChunks = groupSmallSymbols(
      constants,
      filePath,
      language,
      "constants"
    );
    chunks.push(...constChunks);
  }

  // Merge any remaining tiny chunks
  return mergeTinyChunks(chunks);
}

/**
 * Chunk all files from parse results.
 */
export function chunkAllFiles(parseResults: FileParseResult[]): CodeChunk[] {
  const allChunks: CodeChunk[] = [];

  for (const result of parseResults) {
    const fileChunks = chunkFile(result);
    allChunks.push(...fileChunks);
  }

  return allChunks;
}

/**
 * Convert an extracted symbol to a code chunk.
 */
function symbolToChunk(
  symbol: ExtractedSymbol,
  filePath: string,
  language: string
): CodeChunk {
  return {
    filePath,
    symbolName: symbol.name,
    symbolType: symbol.type,
    language,
    content: symbol.content,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    parentScope: symbol.parentScope,
    signature: symbol.signature,
  };
}

/**
 * Group small symbols (types, constants) into combined chunks.
 */
function groupSmallSymbols(
  symbols: ExtractedSymbol[],
  filePath: string,
  language: string,
  groupName: string
): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  let currentContent = "";
  let currentStart = symbols[0]?.startLine || 1;
  let currentEnd = symbols[0]?.endLine || 1;

  for (const symbol of symbols) {
    const addition = symbol.content + "\n\n";

    if (currentContent.length + addition.length > MAX_CHUNK_CHARS) {
      // Flush current group
      if (currentContent.length >= MIN_CHUNK_CHARS) {
        chunks.push({
          filePath,
          symbolName: `${groupName}_group`,
          symbolType: symbols[0].type,
          language,
          content: currentContent.trim(),
          startLine: currentStart,
          endLine: currentEnd,
          parentScope: null,
          signature: `${groupName} (${filePath})`,
        });
      }
      currentContent = addition;
      currentStart = symbol.startLine;
      currentEnd = symbol.endLine;
    } else {
      currentContent += addition;
      currentEnd = symbol.endLine;
    }
  }

  // Flush remaining
  if (currentContent.trim().length >= MIN_CHUNK_CHARS) {
    chunks.push({
      filePath,
      symbolName: `${groupName}_group`,
      symbolType: symbols[0]?.type || "type",
      language,
      content: currentContent.trim(),
      startLine: currentStart,
      endLine: currentEnd,
      parentScope: null,
      signature: `${groupName} (${filePath})`,
    });
  }

  return chunks;
}

/**
 * Split a large chunk into smaller pieces at logical boundaries.
 */
function splitLargeChunk(chunk: CodeChunk): CodeChunk[] {
  const lines = chunk.content.split("\n");
  const chunks: CodeChunk[] = [];
  const maxLines = Math.floor(MAX_CHUNK_CHARS / 80); // Assume ~80 chars/line

  for (let i = 0; i < lines.length; i += maxLines) {
    const sliceLines = lines.slice(i, i + maxLines);
    const partNum = Math.floor(i / maxLines) + 1;

    chunks.push({
      ...chunk,
      symbolName: `${chunk.symbolName}_part${partNum}`,
      content: sliceLines.join("\n"),
      startLine: chunk.startLine + i,
      endLine: chunk.startLine + i + sliceLines.length,
    });
  }

  return chunks;
}

/**
 * Merge chunks that are too small with their neighbors.
 */
function mergeTinyChunks(chunks: CodeChunk[]): CodeChunk[] {
  if (chunks.length <= 1) return chunks;

  const merged: CodeChunk[] = [];
  let pending: CodeChunk | null = null;
  for (const chunk of chunks) pending = foldChunkIntoMergeState(merged, pending, chunk);
  if (pending) merged.push(pending);

  return merged;
}
