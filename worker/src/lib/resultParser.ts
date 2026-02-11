/**
 * Utilities for parsing JSON output from CI tools.
 *
 * Many tools produce JSON to stdout but may also mix in non-JSON lines
 * (progress bars, warnings, etc.).  These helpers extract the JSON portion
 * robustly.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempt to parse a JSON string, returning `null` on failure instead of
 * throwing.  If the input contains non-JSON preamble (common with CI tool
 * output), the function tries to locate the first `{` or `[` and parse
 * from there.
 */
export function parseJsonSafe<T = unknown>(raw: string): T | null {
  if (!raw || !raw.trim()) return null;

  // Fast path: try direct parse
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Fall through to extraction
  }

  // Try to extract JSON object or array from the output
  const extracted = extractJson(raw);
  if (extracted) {
    try {
      return JSON.parse(extracted) as T;
    } catch {
      // Genuinely invalid JSON
    }
  }

  return null;
}

/**
 * Parse a string that contains one JSON object/array per line (NDJSON).
 * Returns an array of successfully parsed objects; invalid lines are skipped.
 */
export function parseNdjson<T = unknown>(raw: string): T[] {
  if (!raw || !raw.trim()) return [];

  const results: T[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      continue;
    }

    try {
      results.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip invalid lines
    }
  }

  return results;
}

/**
 * Parse the output of a command, extracting structured key=value pairs.
 * Useful for tools that output `key: value` style summaries.
 */
export function parseCommandOutput(
  output: string,
): Record<string, unknown> | undefined {
  if (!output || !output.trim()) return undefined;

  // First, try JSON
  const json = parseJsonSafe<Record<string, unknown>>(output);
  if (json && typeof json === "object") return json;

  // Fall back to simple key-value extraction
  const result: Record<string, string> = {};
  const kvPattern = /^([A-Za-z_][\w.-]*)\s*[:=]\s*(.+)$/;

  for (const line of output.split("\n")) {
    const match = line.trim().match(kvPattern);
    if (match) {
      result[match[1]!] = match[2]!.trim();
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Extract numeric values from tool output for metrics.
 * Returns a map of metric name to numeric value.
 */
export function extractMetrics(
  output: string,
  patterns: Record<string, RegExp>,
): Record<string, number> {
  const metrics: Record<string, number> = {};

  for (const [name, pattern] of Object.entries(patterns)) {
    const match = output.match(pattern);
    if (match?.[1]) {
      const value = parseFloat(match[1]);
      if (!isNaN(value)) {
        metrics[name] = value;
      }
    }
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Attempt to extract a JSON object or array from a string that may contain
 * non-JSON content before or after the JSON payload.
 */
function extractJson(raw: string): string | null {
  // Find the first { or [
  const objStart = raw.indexOf("{");
  const arrStart = raw.indexOf("[");

  let start: number;
  let closeChar: string;

  if (objStart === -1 && arrStart === -1) return null;

  if (objStart === -1) {
    start = arrStart;
    closeChar = "]";
  } else if (arrStart === -1) {
    start = objStart;
    closeChar = "}";
  } else if (objStart < arrStart) {
    start = objStart;
    closeChar = "}";
  } else {
    start = arrStart;
    closeChar = "]";
  }

  // Find the matching close bracket by tracking nesting
  const openChar = raw[start]!;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === openChar) depth++;
    if (ch === closeChar) depth--;

    if (depth === 0) {
      return raw.slice(start, i + 1);
    }
  }

  return null;
}
