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

  // Process functions — each becomes its own chunk
  for (const fn of functions) {
    if (fn.parentScope) continue; // Methods handled within class chunks

    const chunk = symbolToChunk(fn, filePath, language);
    if (chunk.content.length <= MAX_CHUNK_CHARS) {
      chunks.push(chunk);
    } else {
      // Split large functions
      chunks.push(...splitLargeChunk(chunk));
    }
  }

  // Process classes — split if too large
  for (const cls of classes) {
    const lineCount = cls.endLine - cls.startLine;

    if (lineCount <= CLASS_SPLIT_THRESHOLD) {
      // Small enough to be one chunk
      const chunk = symbolToChunk(cls, filePath, language);
      if (chunk.content.length <= MAX_CHUNK_CHARS) {
        chunks.push(chunk);
      } else {
        chunks.push(...splitLargeChunk(chunk));
      }
    } else {
      // Split class: header chunk + individual method chunks
      const headerLines = cls.content.split("\n").slice(0, 10);
      chunks.push({
        filePath,
        symbolName: cls.name,
        symbolType: "class",
        language,
        content: headerLines.join("\n") + "\n  // ... (methods below)",
        startLine: cls.startLine,
        endLine: cls.startLine + 10,
        parentScope: null,
        signature: cls.signature,
      });

      // Find methods within this class
      const methods = symbols.filter(
        (s) => s.type === "method" && s.parentScope === cls.name
      );
      for (const method of methods) {
        chunks.push(symbolToChunk(method, filePath, language));
      }
    }
  }

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

  for (const chunk of chunks) {
    if (pending === null) {
      if (chunk.content.length < MIN_CHUNK_CHARS) {
        pending = chunk;
      } else {
        merged.push(chunk);
      }
      continue;
    }

    // Merge pending with current if same file and combined is under limit
    if (
      pending.filePath === chunk.filePath &&
      pending.content.length + chunk.content.length <= MAX_CHUNK_CHARS
    ) {
      pending = {
        ...pending,
        symbolName: `${pending.symbolName}+${chunk.symbolName}`,
        content: pending.content + "\n\n" + chunk.content,
        endLine: chunk.endLine,
      };

      if (pending.content.length >= MIN_CHUNK_CHARS) {
        merged.push(pending);
        pending = null;
      }
    } else {
      // Can't merge — push pending as-is and start new
      merged.push(pending);
      if (chunk.content.length < MIN_CHUNK_CHARS) {
        pending = chunk;
      } else {
        merged.push(chunk);
        pending = null;
      }
    }
  }

  if (pending) {
    merged.push(pending);
  }

  return merged;
}
