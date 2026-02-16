/**
 * Workspace path validation and command blocking utilities.
 * Extracted for testability from routes.ts.
 */

// ---------------------------------------------------------------------------
// Blocked commands (for dev VM safety)
// ---------------------------------------------------------------------------

const BLOCKED_COMMANDS = ["poweroff", "shutdown", "reboot", "halt", "init 0"];

export function isBlockedCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  return BLOCKED_COMMANDS.some(
    (blocked) =>
      trimmed === blocked ||
      trimmed.startsWith(`${blocked} `) ||
      trimmed.includes(`&& ${blocked}`) ||
      trimmed.includes(`; ${blocked}`),
  );
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shell escaping (for search/list-files pattern parameters)
// ---------------------------------------------------------------------------

/**
 * SECURITY (W9): Shell-safe single-quoting.
 * Wraps value in single quotes, escaping any embedded single quotes.
 */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * SECURITY (W9): Validate a glob pattern against a strict character allowlist.
 * Rejects patterns containing shell metacharacters that could enable injection.
 */
const GLOB_ALLOWLIST = /^[\w.*?\/\-\[\]{}]+$/;

export function validateGlobPattern(pattern: string): string {
  if (!GLOB_ALLOWLIST.test(pattern)) {
    throw new Error(
      "Invalid glob pattern: contains disallowed characters. " +
      "Only alphanumeric, *, ?, /, -, _, ., [], {} are allowed.",
    );
  }
  return pattern;
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * SECURITY (W3): Validate that a file path resolves within /workspace/.
 * Prevents directory traversal attacks.
 */
export function validateWorkspacePath(rawPath: string): string {
  // Normalize: prepend /workspace/ if relative
  let resolved = rawPath;
  if (!resolved.startsWith("/")) {
    resolved = `/workspace/${resolved}`;
  }

  // Resolve .. components
  const parts = resolved.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      stack.pop();
    } else if (part !== "" && part !== ".") {
      stack.push(part);
    }
  }
  const normalized = "/" + stack.join("/");

  if (!normalized.startsWith("/workspace/") && normalized !== "/workspace") {
    throw new Error("Path must be within /workspace/");
  }

  return normalized;
}
