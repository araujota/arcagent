export type WorkspaceIsolationMode = "shared_worker" | "dedicated_attempt_vm";

const DEFAULT_MODE: WorkspaceIsolationMode = "shared_worker";

export function getWorkspaceIsolationMode(): WorkspaceIsolationMode {
  const raw = (process.env.WORKSPACE_ISOLATION_MODE ?? DEFAULT_MODE).trim().toLowerCase();
  if (raw === "dedicated_attempt_vm") return "dedicated_attempt_vm";
  return "shared_worker";
}

export function shouldUseDedicatedAttemptVm(bounty: { isTestBounty?: boolean } | null): boolean {
  return getWorkspaceIsolationMode() === "dedicated_attempt_vm" && Boolean(bounty?.isTestBounty);
}
