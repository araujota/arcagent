/**
 * Post-hoc filtering utilities for diff-scoped analysis.
 *
 * These functions filter diagnostic output from tools that must run on the full
 * project (e.g., type checkers, security scanners) down to only the files/lines
 * the agent actually changed.
 */

/**
 * Filter diagnostics to only those in changed files.
 *
 * @param diagnostics - Array of diagnostic objects to filter
 * @param getPath - Extractor that returns the file path from a diagnostic (or undefined)
 * @param changedFiles - List of changed file paths (relative to workspace)
 */
export function filterToChangedFiles<T>(
  diagnostics: T[],
  getPath: (d: T) => string | undefined,
  changedFiles: string[],
): T[] {
  const fileSet = new Set(changedFiles.map(normalizePath));

  return diagnostics.filter((d) => {
    const path = getPath(d);
    if (!path) return false;
    return fileSet.has(normalizePath(path));
  });
}

/**
 * Filter diagnostics to only those on changed lines within changed files.
 *
 * @param diagnostics - Array of diagnostic objects to filter
 * @param getPath - Extractor that returns the file path from a diagnostic
 * @param getLine - Extractor that returns the line number from a diagnostic
 * @param ranges - Map of file → [[startLine, endLine], ...] changed line ranges
 */
export function filterToChangedLines<T>(
  diagnostics: T[],
  getPath: (d: T) => string | undefined,
  getLine: (d: T) => number | undefined,
  ranges: Map<string, [number, number][]>,
): T[] {
  return diagnostics.filter((d) => {
    const path = getPath(d);
    const line = getLine(d);
    if (!path || line === undefined) return false;

    const normalizedPath = normalizePath(path);

    // Check every key in the ranges map
    for (const [rangeFile, fileRanges] of ranges) {
      if (normalizePath(rangeFile) !== normalizedPath) continue;

      for (const [start, end] of fileRanges) {
        if (line >= start && line <= end) {
          return true;
        }
      }
    }

    return false;
  });
}

/**
 * Normalize a file path by stripping leading `/workspace/` or `./` prefixes
 * for consistent comparison.
 */
function normalizePath(p: string): string {
  let normalized = p;
  if (normalized.startsWith("/workspace/")) {
    normalized = normalized.slice("/workspace/".length);
  }
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}
