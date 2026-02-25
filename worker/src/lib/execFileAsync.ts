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
      if (error) {
        const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        err.stdout = stdout ?? "";
        err.stderr = stderr ?? "";
        reject(err);
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}
