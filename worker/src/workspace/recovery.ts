/**
 * Startup recovery logic for orphaned workspace sessions.
 *
 * When a worker process crashes or restarts, its workspace sessions become
 * orphaned in Redis. On startup, this module scans for sessions whose owner
 * worker's heartbeat has expired and attempts to recover them:
 *
 *   1. Generate a new workerInstanceId (UUID)
 *   2. Scan Redis for sessions where the owner's heartbeat has expired
 *   3. For each orphaned "ready" session:
 *      a. Check if the Firecracker PID is still alive (process.kill(pid, 0))
 *      b. If alive, try a vsock ping (waitForVsock with 3 retries, 500ms)
 *      c. If vsock responds: adopt session (update workerInstanceId in Redis)
 *      d. If vsock fails: destroy VM, report crash
 *      e. If PID dead: clean up resources, report crash
 */

import { v4 as uuidv4 } from "uuid";
import { waitForVsock } from "../vm/vsockChannel";
import { destroyFirecrackerVM, VMHandle } from "../vm/firecracker";
import { reportCrash } from "./crashReporter";
import { sessionStore, SessionRecord } from "./sessionStore";
import { logger } from "../index";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a new unique worker instance ID for this process.
 */
export function generateWorkerInstanceId(): string {
  return `worker-${uuidv4()}`;
}

/**
 * Scan Redis for orphaned workspace sessions and attempt recovery.
 *
 * An orphaned session is one whose owner worker's heartbeat key has expired
 * (TTL 30s), meaning the worker process is no longer running or has crashed.
 *
 * Recovery strategy per session:
 * - "provisioning" or "error" status: skip (nothing to recover)
 * - "ready" status: attempt VM reconnection
 * - "destroyed" status: clean up stale Redis entry
 *
 * @param instanceId - The new worker instance ID that will adopt recovered sessions
 * @returns Summary of recovery actions taken
 */
export async function recoverOrphanedSessions(
  instanceId: string,
): Promise<{
  scanned: number;
  adopted: number;
  destroyed: number;
  skipped: number;
}> {
  const stats = { scanned: 0, adopted: 0, destroyed: 0, skipped: 0 };

  logger.info("Starting orphaned session recovery scan", { instanceId });

  let allSessions: SessionRecord[];
  try {
    allSessions = await sessionStore.listActive();
  } catch (err) {
    logger.error("Failed to list active sessions for recovery", {
      error: err instanceof Error ? err.message : String(err),
    });
    return stats;
  }

  stats.scanned = allSessions.length;

  if (allSessions.length === 0) {
    logger.info("No active sessions found in Redis — nothing to recover");
    return stats;
  }

  // Group sessions by owning worker
  const sessionsByWorker = new Map<string, SessionRecord[]>();
  for (const session of allSessions) {
    const workerId = session.workerInstanceId;
    let list = sessionsByWorker.get(workerId);
    if (!list) {
      list = [];
      sessionsByWorker.set(workerId, list);
    }
    list.push(session);
  }

  // Check each worker's heartbeat
  for (const [workerId, sessions] of sessionsByWorker) {
    // Skip our own sessions (shouldn't exist yet, but be safe)
    if (workerId === instanceId) {
      stats.skipped += sessions.length;
      continue;
    }

    // Check if the owner worker is still alive
    const heartbeat = await sessionStore.getWorkerHeartbeat(workerId);
    if (heartbeat !== null) {
      // Worker is still alive — skip its sessions
      logger.debug("Worker still alive, skipping its sessions", {
        workerId,
        sessionCount: sessions.length,
      });
      stats.skipped += sessions.length;
      continue;
    }

    // Worker heartbeat expired — sessions are orphaned
    logger.warn("Worker heartbeat expired — recovering orphaned sessions", {
      workerId,
      sessionCount: sessions.length,
    });

    for (const session of sessions) {
      try {
        await recoverSession(session, instanceId);
        stats.adopted++;
      } catch (err) {
        logger.error("Failed to recover session", {
          workspaceId: session.workspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
        stats.destroyed++;
      }
    }
  }

  logger.info("Orphaned session recovery complete", stats);
  return stats;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to recover a single orphaned session.
 *
 * For "ready" sessions: check PID liveness, then vsock connectivity.
 * For other statuses: clean up the Redis entry.
 */
async function recoverSession(
  session: SessionRecord,
  newInstanceId: string,
): Promise<void> {
  const { workspaceId, vmId, firecrackerPid, vsockSocketPath, status } =
    session;

  // Only attempt recovery for "ready" sessions
  if (status !== "ready") {
    logger.info("Cleaning up non-ready orphaned session", {
      workspaceId,
      status,
    });

    // For destroyed/error/provisioning, just clean up Redis
    await sessionStore.delete(workspaceId);

    await reportCrash({
      workspaceId,
      bountyId: session.bountyId,
      agentId: session.agentId,
      claimId: session.claimId,
      vmId,
      workerInstanceId: session.workerInstanceId,
      crashType: "worker_restart",
      errorMessage: `Orphaned session in "${status}" status after worker restart`,
      lastKnownStatus: status,
      recovered: false,
      recoveryAction: "abandoned",
    });

    return;
  }

  // Step 1: Check if the Firecracker process is still alive
  const pidAlive = isPidAlive(firecrackerPid);

  if (!pidAlive) {
    // PID is dead — the VM is gone, clean up
    logger.warn("Firecracker PID dead for orphaned session", {
      workspaceId,
      vmId,
      pid: firecrackerPid,
    });

    await sessionStore.delete(workspaceId);

    await reportCrash({
      workspaceId,
      bountyId: session.bountyId,
      agentId: session.agentId,
      claimId: session.claimId,
      vmId,
      workerInstanceId: session.workerInstanceId,
      crashType: "vm_process_exited",
      errorMessage: `Firecracker process (PID ${firecrackerPid}) no longer alive after worker restart`,
      lastKnownStatus: status,
      recovered: false,
      recoveryAction: "abandoned",
    });

    return;
  }

  // Step 2: PID is alive — try vsock ping to verify VM is responsive
  logger.info("Firecracker PID alive, attempting vsock reconnection", {
    workspaceId,
    vmId,
    pid: firecrackerPid,
  });

  try {
    await waitForVsock(vsockSocketPath, vmId, 3, 500);

    // Vsock responded — adopt the session
    await sessionStore.adoptSession(workspaceId, newInstanceId);
    await sessionStore.updateHeartbeat(workspaceId);

    logger.info("Successfully adopted orphaned session", {
      workspaceId,
      vmId,
      newInstanceId,
    });

    return;
  } catch (vsockErr) {
    // Vsock failed — VM process exists but is unresponsive
    logger.warn("Vsock ping failed for orphaned session — destroying VM", {
      workspaceId,
      vmId,
      error:
        vsockErr instanceof Error ? vsockErr.message : String(vsockErr),
    });

    // Destroy the unresponsive VM
    try {
      // Build a minimal VMHandle for the destroy function
      const handle: VMHandle = {
        vmId,
        jobId: workspaceId,
        // Use real guest IP so releaseGuestIp returns it to the pool
        guestIp: session.guestIp ?? "0.0.0.0",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
      };

      // Attach internal metadata that destroyFirecrackerVM needs
      const internal = handle as unknown as Record<string, unknown>;
      internal.__tapDevice = session.tapDevice;
      internal.__overlayPath = session.overlayPath;
      internal.__vsockSocketPath = vsockSocketPath;
      internal.__firecrackerPid = firecrackerPid;

      await destroyFirecrackerVM(handle);
    } catch (destroyErr) {
      logger.error("Failed to destroy unresponsive VM during recovery", {
        workspaceId,
        vmId,
        error:
          destroyErr instanceof Error
            ? destroyErr.message
            : String(destroyErr),
      });
    }

    // Clean up Redis
    await sessionStore.delete(workspaceId);

    await reportCrash({
      workspaceId,
      bountyId: session.bountyId,
      agentId: session.agentId,
      claimId: session.claimId,
      vmId,
      workerInstanceId: session.workerInstanceId,
      crashType: "vm_unresponsive",
      errorMessage: `VM process alive (PID ${firecrackerPid}) but vsock unresponsive after worker restart`,
      lastKnownStatus: status,
      recovered: false,
      recoveryAction: "abandoned",
    });
  }
}

/**
 * Check if a PID is still alive using the "kill 0" trick.
 * Sends signal 0 (no actual signal) — returns true if the process exists.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
