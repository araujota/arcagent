/**
 * Shell argument sanitization utilities.
 *
 * Validates inputs against strict patterns before they are interpolated
 * into shell commands executed inside Firecracker VMs.
 */

const PATTERNS: Record<string, RegExp> = {
  repoUrl: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/,
  repoCloneUrl: /^https:\/\/(?:x-access-token:[A-Za-z0-9_-]+@)?github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/,
  commitSha: /^[a-f0-9]{7,40}$/,
  // SECURITY (C5): File path pattern rejects shell metacharacters.
  // Only allows alphanumeric, hyphens, underscores, dots, forward slashes,
  // and @ (used in scoped packages like @scope/pkg).
  filePath: /^[\w./@ -]+$/,
};

/**
 * Validate a value against a named pattern and return it single-quote wrapped
 * for safe shell interpolation.
 *
 * @throws Error if the value does not match the expected pattern.
 */
export function sanitizeShellArg(
  value: string,
  patternName: keyof typeof PATTERNS,
  label: string,
): string {
  const pattern = PATTERNS[patternName];
  if (!pattern) {
    throw new Error(`Unknown sanitization pattern: ${String(patternName)}`);
  }
  if (!pattern.test(value)) {
    throw new Error(
      `Invalid ${label}: value does not match expected format (${String(patternName)})`,
    );
  }
  // Single-quote wrap to prevent any interpretation by the shell.
  // The value is already validated to contain no single quotes.
  return `'${value}'`;
}

/**
 * Validate without wrapping — for cases where the caller needs the raw value
 * after confirming it is safe.
 */
export function validateShellArg(
  value: string,
  patternName: keyof typeof PATTERNS,
  label: string,
): string {
  const pattern = PATTERNS[patternName];
  if (!pattern) {
    throw new Error(`Unknown sanitization pattern: ${String(patternName)}`);
  }
  if (!pattern.test(value)) {
    throw new Error(
      `Invalid ${label}: value does not match expected format (${String(patternName)})`,
    );
  }
  return value;
}

/**
 * SECURITY (C5): Sanitize a file path for safe shell interpolation.
 * Rejects paths containing shell metacharacters that could enable
 * command injection (e.g., single quotes, semicolons, pipes, backticks).
 *
 * Returns the path single-quote wrapped for safe shell use, or null
 * if the path contains unsafe characters (caller should skip the file).
 */
export function sanitizeFilePath(path: string): string | null {
  const pattern = PATTERNS.filePath;
  if (!pattern.test(path)) {
    return null; // Skip files with unsafe names
  }
  return `'${path}'`;
}
