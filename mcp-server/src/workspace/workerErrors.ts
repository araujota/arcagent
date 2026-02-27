import { WorkerHttpError } from "../worker/client";

const WORKSPACE_MISSING_PATTERNS = [
  /workspace not found/i,
  /workspace not found or not ready/i,
];

export function isMissingWorkspaceSessionError(err: unknown): boolean {
  if (err instanceof WorkerHttpError && err.status === 404) {
    return WORKSPACE_MISSING_PATTERNS.some((pattern) => pattern.test(err.message));
  }
  if (err instanceof Error) {
    return WORKSPACE_MISSING_PATTERNS.some((pattern) => pattern.test(err.message));
  }
  return false;
}

export function staleWorkspaceSessionMessage(): string {
  return (
    "Worker session is missing even though control-plane status was `ready`.\n\n" +
    "This usually means the worker restarted or evicted the session.\n\n" +
    "Run `workspace_status` again. If it remains unavailable, use `workspace_startup_log` " +
    "for diagnostics and reprovision by releasing/reclaiming the bounty claim."
  );
}
