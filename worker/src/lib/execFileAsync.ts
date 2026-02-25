import { execFile } from "node:child_process";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";

export interface ExecFileAsyncResult {
  stdout: string;
  stderr: string;
}

/**
 * Promise wrapper for child_process.execFile without util.promisify.
 * Preserves stdout/stderr on thrown errors for callers that inspect them.
 */
export function execFileAsync(
  file: string,
  args: readonly string[] = [],
  options: ExecFileOptionsWithStringEncoding = {},
): Promise<ExecFileAsyncResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      const normalized = normalizeStdoutStderr(stdout, stderr);
      if (error) {
        const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        err.stdout = normalized.stdout;
        err.stderr = normalized.stderr;
        reject(err);
        return;
      }
      resolve(normalized);
    });
  });
}

function normalizeStdoutStderr(
  stdout: string | Buffer | unknown,
  stderr: string | Buffer | unknown,
): ExecFileAsyncResult {
  // Some tests/mocks return `{ stdout, stderr }` as the second callback arg.
  if (stdout && typeof stdout === "object" && "stdout" in (stdout as Record<string, unknown>)) {
    const obj = stdout as { stdout?: unknown; stderr?: unknown };
    return {
      stdout: toStringSafe(obj.stdout),
      stderr: toStringSafe(obj.stderr),
    };
  }
  return {
    stdout: toStringSafe(stdout),
    stderr: toStringSafe(stderr),
  };
}

function toStringSafe(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value === null || value === undefined) return "";
  return String(value);
}
