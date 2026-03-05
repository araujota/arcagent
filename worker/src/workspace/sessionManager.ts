/**
 * Dev VM lifecycle management for workspace sessions.
 *
 * Manages in-memory state for dev VMs provisioned on claim creation.
 * Each session wraps a Firecracker VM handle and tracks lifecycle events.
 */

import { logger } from "../index";
import { createFirecrackerVM, destroyFirecrackerVM, VMHandle } from "../vm/firecracker";
import { getVMConfig, VMResourceConfig } from "../vm/vmConfig";
import { sanitizeShellArg } from "../lib/shellSanitize";
import { vmPool } from "../vm/vmPool";
import { sessionStore } from "./sessionStore";
import { workspaceHeartbeat } from "./heartbeat";
import { cleanupStreamJobs } from "./routes";
import { buildAuthenticatedCloneRepoUrl } from "../lib/repoProviderAuth";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceSession {
  workspaceId: string;
  vmHandle: VMHandle;
  claimId: string;
  bountyId: string;
  agentId: string;
  language: string;
  baseRepoUrl: string;
  baseCommitSha: string;
  status: "provisioning" | "ready" | "error" | "destroyed";
  createdAt: number;
  readyAt?: number;
  expiresAt: number;
  lastActivityAt: number;
  destroyTimer: NodeJS.Timeout | null;
  errorMessage?: string;
  /** Default persistent PTY shell session ID. */
  defaultSessionId?: string;
}

export interface DiffOutput {
  diffPatch: string;
  diffStat: string;
  changedFiles: string[];
  hasChanges: boolean;
}

export interface CapacityError extends Error {
  retryAfterMs: number;
}

export interface ProvisionOptions {
  workspaceId: string;
  claimId: string;
  bountyId: string;
  agentId: string;
  repoUrl: string;
  repoAuthToken?: string;
  repoAuthUsername?: string;
  commitSha: string;
  language: string;
  expiresAt: number;
}

function redactToken(value: string, token?: string): string {
  if (!token) return value;
  return value.split(token).join("<redacted>");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DEV_VMS = parseInt(process.env.MAX_DEV_VMS ?? "10", 10);
const WORKSPACE_IDLE_TIMEOUT_MS = parseInt(
  process.env.WORKSPACE_IDLE_TIMEOUT_MS ?? "1800000",
  10,
); // 30 min default
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const ERROR_SESSION_CLEANUP_MS = 5 * 60 * 1000; // 5 min
const PROVISIONING_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — provisioning that takes longer is stuck
const MAX_DIFF_SIZE = 10 * 1024 * 1024; // 10 MiB
const MAX_CHANGED_FILES = 500;
const DEFAULT_DIFF_EXCLUDE_GLOBS = [
  // JS/TS package manager caches
  ".npm/_cacache/**",
  ".npm/_logs/**",
  ".npm/_npx/**",
  ".npm/_update-notifier-last-checked",
  "node_modules/**",
  ".pnpm-store/**",
  ".yarn/cache/**",
  // Common build artifacts and local caches
  ".next/**",
  "dist/**",
  "coverage/**",
  ".cache/**",
  "tmp/**",
  // Common Python caches
  "__pycache__/**",
  ".pytest_cache/**",
  ".mypy_cache/**",
  ".ruff_cache/**",
];
const DIFF_EXCLUDE_GLOBS = parseDiffExcludeGlobs(process.env.WORKSPACE_DIFF_EXCLUDE_GLOBS);
const GIT_PATHSPEC_GLOB_PATTERN = /^[A-Za-z0-9_./*?{}\[\]-]+$/;

function parseDiffExcludeGlobs(raw: string | undefined): string[] {
  if (raw === undefined) return DEFAULT_DIFF_EXCLUDE_GLOBS;
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sanitizeDiffExcludeGlob(glob: string): string {
  if (!GIT_PATHSPEC_GLOB_PATTERN.test(glob)) {
    throw new Error(`Invalid WORKSPACE_DIFF_EXCLUDE_GLOBS entry: ${glob}`);
  }
  return `':(glob)${glob}'`;
}

export interface CapacityStats {
  maxDevVms: number;
  totalSessions: number;
  activeForCapacity: number;
  byStatus: Record<WorkspaceSession["status"] | "unknown", number>;
  sessions: Array<{
    workspaceId: string;
    status: WorkspaceSession["status"];
    createdAt: number;
    readyAt?: number;
    expiresAt: number;
    lastActivityAt: number;
    claimId: string;
    bountyId: string;
    agentId: string;
  }>;
}

function isProvisionCapacityActive(session: WorkspaceSession, now: number): boolean {
  if (session.status === "ready") {
    return session.expiresAt > now;
  }
  if (session.status === "provisioning") {
    return now - session.createdAt <= PROVISIONING_TIMEOUT_MS;
  }
  return false;
}

function getCapacityStats(now: number = Date.now()): CapacityStats {
  const allSessions = Array.from(sessions.values()).filter(
    (s) => s.status !== "destroyed",
  );
  const byStatus: CapacityStats["byStatus"] = {
    provisioning: 0,
    ready: 0,
    error: 0,
    destroyed: 0,
    unknown: 0,
  };

  for (const session of allSessions) {
    byStatus[session.status] = (byStatus[session.status] || 0) + 1;
  }

  return {
    maxDevVms: MAX_DEV_VMS,
    totalSessions: allSessions.length,
    activeForCapacity: allSessions.filter((s) => isProvisionCapacityActive(s, now)).length,
    byStatus,
    sessions: allSessions.map((session) => ({
      workspaceId: session.workspaceId,
      status: session.status,
      createdAt: session.createdAt,
      readyAt: session.readyAt,
      expiresAt: session.expiresAt,
      lastActivityAt: session.lastActivityAt,
      claimId: session.claimId,
      bountyId: session.bountyId,
      agentId: session.agentId,
    })),
  };
}

export function getCapacityStatsSnapshot(): CapacityStats {
  return getCapacityStats();
}

async function pruneStaleSessionsForCapacity(now: number = Date.now()): Promise<void> {
  const stale: string[] = [];
  for (const [workspaceId, session] of sessions) {
    if (
      session.status === "ready" &&
      (session.expiresAt <= now || now - session.lastActivityAt > WORKSPACE_IDLE_TIMEOUT_MS)
    ) {
      stale.push(workspaceId);
      continue;
    }

    if (
      session.status === "provisioning" &&
      now - session.createdAt > PROVISIONING_TIMEOUT_MS
    ) {
      stale.push(workspaceId);
      continue;
    }

    if (session.status === "error" && now - session.createdAt > ERROR_SESSION_CLEANUP_MS) {
      stale.push(workspaceId);
    }
  }

  for (const workspaceId of stale) {
    logger.info("Pruning stale session during capacity check", {
      workspaceId,
    });
    await destroyWorkspace(workspaceId, "error_cleanup").catch((err) => {
      logger.error("Failed to prune stale workspace during capacity check", {
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

const sessions = new Map<string, WorkspaceSession>();
let idleCheckTimer: NodeJS.Timeout | null = null;

let workerInstanceId = "unknown";
export function setWorkerInstanceId(id: string) { workerInstanceId = id; }

// ---------------------------------------------------------------------------
// Startup cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up orphaned dev VMs from previous unclean shutdowns.
 * Called once on worker startup before accepting new workspace requests.
 *
 * This does NOT kill verification VM processes (those have their own cleanup
 * via the existing `cleanupStaleCryptDevices` call). We only target workspace
 * VMs that might have been left behind if the worker process crashed.
 */
export async function cleanupOrphanedWorkspaces(): Promise<void> {
  // The session map is empty on startup — nothing to clean up there.
  // But orphaned Firecracker processes from a previous lifecycle may still exist.
  // The existing `cleanupStaleCryptDevices` handles dm-crypt devices and TAP interfaces.
  // Here we just log the fresh start.
  logger.info("Workspace session manager initialized (no orphaned sessions to clean up)");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Provision a new dev VM workspace.
 *
 * 1. Checks capacity limits
 * 2. Creates Firecracker VM with dev-class resources
 * 3. Clones repo at specified commit
 * 4. Installs dependencies
 * 5. Sets ownership to agent user
 */
export async function provisionWorkspace(
  opts: ProvisionOptions,
): Promise<WorkspaceSession> {
  // Idempotency: if workspace already exists and isn't destroyed, return it
  const existing = sessions.get(opts.workspaceId);
  if (existing && existing.status !== "destroyed") {
    logger.info("Returning existing workspace session (idempotent)", {
      workspaceId: opts.workspaceId,
      status: existing.status,
    });
    return existing;
  }

  const now = Date.now();
  await pruneStaleSessionsForCapacity(now);

  // Capacity check — count only capacity-bearing sessions (ready or active provisioning)
  const activeSessions = Array.from(sessions.values()).filter((s) =>
    isProvisionCapacityActive(s, now),
  );

  const capacityStats = getCapacityStats(now);
  logger.debug("Capacity snapshot before provision", capacityStats);

  if (activeSessions.length >= MAX_DEV_VMS) {
    // Find the nearest TTL expiry for a retry hint
    const nearestExpiry = activeSessions
      .filter((s) => s.expiresAt > now)
      .reduce((min, s) => Math.min(min, s.expiresAt), Infinity);
    const retryAfterMs = nearestExpiry === Infinity
      ? 60_000 // fallback: suggest 60s
      : Math.max(nearestExpiry - now + 1000, 5000); // add 1s buffer

    const err = new Error(
      "Worker at capacity. Please try again later.",
    );
    (err as CapacityError).retryAfterMs = retryAfterMs;
    throw err;
  }

  const vmConfig = getDevVMConfig(opts.language);

  logger.info("Provisioning dev workspace", {
    workspaceId: opts.workspaceId,
    claimId: opts.claimId,
    language: opts.language,
  });

  // Create session entry first (status: provisioning)
  const session: WorkspaceSession = {
    workspaceId: opts.workspaceId,
    vmHandle: null as unknown as VMHandle, // filled after VM creation
    claimId: opts.claimId,
    bountyId: opts.bountyId,
    agentId: opts.agentId,
    language: opts.language,
    baseRepoUrl: opts.repoUrl,
    baseCommitSha: opts.commitSha,
    status: "provisioning",
    createdAt: Date.now(),
    expiresAt: opts.expiresAt,
    lastActivityAt: Date.now(),
    destroyTimer: null,
  };
  sessions.set(opts.workspaceId, session);

  // Persist initial session state to Redis
  await sessionStore.save({
    workspaceId: opts.workspaceId,
    vmId: "",
    vsockSocketPath: "",
    tapDevice: "",
    overlayPath: "",
    claimId: opts.claimId,
    bountyId: opts.bountyId,
    agentId: opts.agentId,
    language: opts.language,
    baseRepoUrl: opts.repoUrl,
    baseCommitSha: opts.commitSha,
    status: "provisioning",
    createdAt: session.createdAt,
    expiresAt: opts.expiresAt,
    lastActivityAt: session.lastActivityAt,
    lastHeartbeatAt: Date.now(),
    firecrackerPid: 0,
    workerInstanceId,
  }).catch((err) => {
    logger.warn("Failed to save session to Redis", {
      workspaceId: opts.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  try {
    // Try warm pool first, fall back to fresh VM boot
    let vm: VMHandle;
    const warmVM = await vmPool.acquire(opts.language).catch(() => null);
    if (warmVM) {
      vm = warmVM;
      logger.info("Using warm VM for workspace", {
        workspaceId: opts.workspaceId,
        language: opts.language,
        vmId: vm.vmId,
      });
    } else {
      const vmJobId = `ws-${randomUUID()}`;
      vm = await createFirecrackerVM({
        jobId: vmJobId,
        rootfsImage: vmConfig.rootfsImage,
        vcpuCount: vmConfig.vcpuCount,
        memSizeMib: vmConfig.memSizeMib,
      });
    }
    session.vmHandle = vm;

    // Clone repo (as root for initial setup)
    const cloneRepo = buildAuthenticatedCloneRepoUrl(
      opts.repoUrl,
      opts.repoAuthToken,
      opts.repoAuthUsername,
    );
    const safeRepoUrl = sanitizeShellArg(cloneRepo.url, "repoCloneUrl", "repoUrl");
    const safeCommitSha = sanitizeShellArg(opts.commitSha, "commitSha", "commitSha");

    const cloneCmd = `git clone ${safeRepoUrl} /workspace && cd /workspace && git checkout ${safeCommitSha}`;
    const cloneResult = await vm.exec(cloneCmd, 300_000); // 5 min for large repos
    if (cloneResult.exitCode !== 0) {
      const combined = `${cloneResult.stderr}\n${cloneResult.stdout}`.trim();
      throw new Error(`Failed to clone repo: ${redactToken(combined, cloneRepo.tokenForRedaction).slice(0, 500)}`);
    }

    // Set ownership to agent user
    await vm.exec("chown -R agent:agent /workspace", 30_000);

    // Install dependencies based on language
    await installDependencies(vm, opts.language);

    // Mark ready
    session.status = "ready";
    session.readyAt = Date.now();
    session.lastActivityAt = Date.now();

    // Persist full session state to Redis with VM metadata
    const vmInt = vm as unknown as Record<string, unknown>;
    await sessionStore.save({
      workspaceId: opts.workspaceId,
      vmId: vm.vmId,
      vsockSocketPath: (vmInt.__vsockSocketPath as string) ?? "",
      tapDevice: (vmInt.__tapDevice as string) ?? "",
      overlayPath: (vmInt.__overlayPath as string) ?? "",
      guestIp: vm.guestIp,
      claimId: opts.claimId,
      bountyId: opts.bountyId,
      agentId: opts.agentId,
      language: opts.language,
      baseRepoUrl: opts.repoUrl,
      baseCommitSha: opts.commitSha,
      status: "ready",
      createdAt: session.createdAt,
      readyAt: session.readyAt,
      expiresAt: opts.expiresAt,
      lastActivityAt: session.lastActivityAt,
      lastHeartbeatAt: Date.now(),
      firecrackerPid: (vmInt.__firecrackerPid as number) ?? 0,
      workerInstanceId,
    }).catch((err) => {
      logger.warn("Failed to update session in Redis", {
        workspaceId: opts.workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Start heartbeat monitoring for this workspace
    const vsockPath = (vmInt.__vsockSocketPath as string) ?? "";
    if (vsockPath) {
      workspaceHeartbeat.startMonitoring(opts.workspaceId, vsockPath, vm.vmId);
    }

    // Schedule destroy timer at expiresAt
    const ttl = opts.expiresAt - Date.now();
    if (ttl > 0) {
      session.destroyTimer = setTimeout(() => {
        destroyWorkspace(opts.workspaceId, "ttl_expired").catch((err) => {
          logger.error("Failed to destroy workspace on TTL", {
            workspaceId: opts.workspaceId,
            error: String(err),
          });
        });
      }, ttl);
    }

    logger.info("Dev workspace ready", {
      workspaceId: opts.workspaceId,
      vmId: vm.vmId,
      readyInMs: session.readyAt - session.createdAt,
    });

    return session;
  } catch (err) {
    session.status = "error";
    session.errorMessage =
      err instanceof Error ? err.message : String(err);

    logger.error("Failed to provision workspace", {
      workspaceId: opts.workspaceId,
      error: session.errorMessage,
    });

    // Update Redis with error status
    await sessionStore.updateStatus(opts.workspaceId, "error").catch(() => {});

    // Clean up VM if it was created
    if (session.vmHandle) {
      await destroyFirecrackerVM(session.vmHandle).catch(() => {});
      session.vmHandle = null as unknown as VMHandle; // prevent double-destroy by idle checker
    }

    throw err;
  }
}

/**
 * Get a workspace session by ID.
 */
export function getSession(workspaceId: string): WorkspaceSession | undefined {
  return sessions.get(workspaceId);
}

/**
 * Destroy a workspace VM and clean up resources.
 */
export async function destroyWorkspace(
  workspaceId: string,
  reason: string,
): Promise<void> {
  const session = sessions.get(workspaceId);
  if (!session) return;
  if (session.status === "destroyed") return;

  logger.info("Destroying workspace", { workspaceId, reason });

  // Stop heartbeat monitoring before VM destroy
  workspaceHeartbeat.stopMonitoring(workspaceId);

  // Clean up streaming exec job records for this workspace
  cleanupStreamJobs(workspaceId);

  // Clear destroy timer
  if (session.destroyTimer) {
    clearTimeout(session.destroyTimer);
    session.destroyTimer = null;
  }

  // Destroy the VM
  if (session.vmHandle) {
    await destroyFirecrackerVM(session.vmHandle).catch((err) => {
      logger.error("Failed to destroy VM", {
        workspaceId,
        error: String(err),
      });
    });
  }

  session.status = "destroyed";

  // Update Redis with destroyed status
  await sessionStore.updateStatus(workspaceId, "destroyed").catch(() => {});

  // Keep in map for a while so status queries work, then GC
  setTimeout(() => {
    sessions.delete(workspaceId);
    sessionStore.delete(workspaceId).catch(() => {});
  }, 5 * 60 * 1000);
}

/**
 * Extract a unified diff of all agent changes from the workspace.
 */
export async function extractDiff(
  workspaceId: string,
): Promise<DiffOutput> {
  const session = sessions.get(workspaceId);
  if (!session || session.status !== "ready") {
    throw new Error("Workspace not ready");
  }

  const vm = session.vmHandle;

  // Single exec call: stage + unstage noise + diff + stat + names using delimiter-separated output
  // Reduces multiple sequential vsock round-trips to 1 while filtering common cache/build artifacts.
  const excludePathspecArgs = DIFF_EXCLUDE_GLOBS
    .map((glob) => sanitizeDiffExcludeGlob(glob))
    .join(" ");
  const unstageNoiseCmd = excludePathspecArgs.length > 0
    ? ` && (git reset -q HEAD -- ${excludePathspecArgs} || true)`
    : "";
  const combinedCmd =
    `cd /workspace && git add -A${unstageNoiseCmd} && ` +
    `echo '---DIFF---' && git diff --cached HEAD && ` +
    `echo '---STAT---' && git diff --cached --stat HEAD && ` +
    `echo '---NAMES---' && git diff --cached --name-only HEAD`;

  const combinedResult = await vm.exec(combinedCmd, 60_000, "agent");
  if (combinedResult.exitCode !== 0) {
    const stderr = combinedResult.stderr.trim();
    throw new Error(
      `Failed to extract workspace diff (exit ${combinedResult.exitCode})${
        stderr ? `: ${stderr}` : ""
      }`,
    );
  }
  const output = combinedResult.stdout;

  // Split on delimiter markers
  const diffStart = output.indexOf("---DIFF---\n");
  const statStart = output.indexOf("---STAT---\n");
  const namesStart = output.indexOf("---NAMES---\n");
  const markersValid =
    diffStart >= 0 &&
    statStart > diffStart &&
    namesStart > statStart;
  if (!markersValid) {
    throw new Error(
      "Failed to parse workspace diff output (missing delimiter markers). " +
      "The output may be truncated; reduce workspace noise and retry.",
    );
  }

  // Preserve exact patch bytes (including trailing newline) so `git apply`
  // receives a syntactically valid unified diff.
  const diffPatch = output.substring(diffStart + "---DIFF---\n".length, statStart);
  const diffStat = output.substring(statStart + "---STAT---\n".length, namesStart).trimEnd();
  const namesRaw = output.substring(namesStart + "---NAMES---\n".length).trimEnd();

  const changedFiles = namesRaw.split("\n").filter(Boolean);

  // Validate diff size
  if (Buffer.byteLength(diffPatch, "utf-8") > MAX_DIFF_SIZE) {
    throw new Error(
      `Diff too large (>${MAX_DIFF_SIZE / 1024 / 1024}MB). Reduce the scope of your changes.`,
    );
  }
  if (changedFiles.length > MAX_CHANGED_FILES) {
    throw new Error(
      `Too many changed files (${changedFiles.length} > ${MAX_CHANGED_FILES}). Reduce the scope of your changes.`,
    );
  }

  return {
    diffPatch,
    diffStat,
    changedFiles,
    hasChanges: changedFiles.length > 0,
  };
}

/**
 * Extend the TTL of a workspace.
 */
export function extendTTL(
  workspaceId: string,
  newExpiresAt: number,
): void {
  const session = sessions.get(workspaceId);
  if (!session || session.status === "destroyed") return;

  session.expiresAt = newExpiresAt;

  // Reset destroy timer
  if (session.destroyTimer) {
    clearTimeout(session.destroyTimer);
  }
  const ttl = newExpiresAt - Date.now();
  if (ttl > 0) {
    session.destroyTimer = setTimeout(() => {
      destroyWorkspace(workspaceId, "ttl_expired").catch(() => {});
    }, ttl);
  }
}

/**
 * Touch lastActivityAt for idle tracking.
 */
export function touchActivity(workspaceId: string): void {
  const session = sessions.get(workspaceId);
  if (session) {
    session.lastActivityAt = Date.now();
    sessionStore.updateActivity(workspaceId).catch(() => {});
  }
}

/**
 * List all active (non-destroyed) sessions.
 */
export function listActiveSessions(): WorkspaceSession[] {
  return Array.from(sessions.values()).filter(
    (s) => s.status !== "destroyed",
  );
}

/**
 * Start the idle timeout checker interval.
 */
export function startIdleChecker(): void {
  if (idleCheckTimer) return;

  idleCheckTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      // Clean up idle ready sessions
      if (session.status === "ready" && now - session.lastActivityAt > WORKSPACE_IDLE_TIMEOUT_MS) {
        logger.info("Destroying idle workspace", {
          workspaceId: id,
          idleMs: now - session.lastActivityAt,
        });
        destroyWorkspace(id, "idle_timeout").catch(() => {});
        continue;
      }
      // Clean up error sessions older than 5 minutes
      if (session.status === "error" && now - session.createdAt > ERROR_SESSION_CLEANUP_MS) {
        logger.info("Cleaning up error workspace", {
          workspaceId: id,
          ageMs: now - session.createdAt,
        });
        destroyWorkspace(id, "error_cleanup").catch(() => {});
        continue;
      }
      // Clean up stuck provisioning sessions (>10 min = likely dead)
      if (session.status === "provisioning" && now - session.createdAt > PROVISIONING_TIMEOUT_MS) {
        logger.warn("Cleaning up stuck provisioning workspace", {
          workspaceId: id,
          ageMs: now - session.createdAt,
        });
        destroyWorkspace(id, "provisioning_timeout").catch(() => {});
      }
    }
  }, IDLE_CHECK_INTERVAL_MS);
}

/**
 * Destroy all active sessions (for graceful shutdown).
 */
export async function destroyAllSessions(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [id, session] of sessions) {
    if (session.status !== "destroyed") {
      promises.push(destroyWorkspace(id, "shutdown"));
    }
  }
  await Promise.allSettled(promises);

  if (idleCheckTimer) {
    clearInterval(idleCheckTimer);
    idleCheckTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get VM config with dev-class resource overrides.
 * Dev VMs get more resources for interactive work (npm install, etc.)
 */
function getDevVMConfig(language: string): VMResourceConfig {
  const base = getVMConfig(language);
  return {
    ...base,
    vcpuCount: Math.max(base.vcpuCount, 2),
    memSizeMib: Math.max(base.memSizeMib, 2048),
    // SECURITY (W1): Remove github.com from dev VM allowed domains
    // The repo is already cloned — no git access needed during dev.
    // This prevents code exfiltration via `git push`.
    allowedDomains: base.allowedDomains.filter(
      (d) => d !== "github.com" && d !== "*.github.com" && d !== "objects.githubusercontent.com",
    ),
  };
}

/**
 * Install dependencies based on detected language.
 */
async function installDependencies(
  vm: VMHandle,
  language: string,
): Promise<void> {
  const lang = language.toLowerCase().trim();
  let installCmd: string | null = null;

  switch (lang) {
    case "typescript":
    case "javascript":
      // Try npm ci first, fall back to npm install
      installCmd =
        "cd /workspace && ([ -f package-lock.json ] && npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts 2>/dev/null) || true";
      break;
    case "python":
      installCmd =
        "cd /workspace && ([ -f requirements.txt ] && pip install -r requirements.txt 2>/dev/null) || true";
      break;
    case "rust":
      installCmd = "cd /workspace && cargo fetch 2>/dev/null || true";
      break;
    case "go":
      installCmd = "cd /workspace && go mod download 2>/dev/null || true";
      break;
    default:
      return; // no deps to install
  }

  if (installCmd) {
    logger.info("Installing dependencies", { language: lang });
    // Run as agent user, generous timeout for large dep trees
    await vm.exec(installCmd, 300_000, "agent");
  }
}
