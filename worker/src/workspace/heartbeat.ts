/**
 * Heartbeat monitor for workspace VMs and the worker process itself.
 *
 * Two heartbeat loops:
 *
 * 1. **Per-workspace heartbeat** — Every 30 seconds, sends a vsock ping to
 *    the VM guest agent and updates the lastHeartbeatAt in Redis. If 3
 *    consecutive pings fail, the workspace is considered crashed: a crash
 *    report is filed and the VM is destroyed.
 *
 * 2. **Worker-level heartbeat** — Every 15 seconds, updates the worker
 *    instance heartbeat key in Redis with a 30-second TTL. Other workers
 *    check this key during recovery to determine if a worker is still alive.
 */

import { vsockExec } from "../vm/vsockChannel";
import { destroyFirecrackerVM, VMHandle } from "../vm/firecracker";
import { reportCrash } from "./crashReporter";
import { sessionStore } from "./sessionStore";
import { logger } from "../index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Interval between workspace vsock heartbeat pings (ms). */
const WORKSPACE_HEARTBEAT_INTERVAL_MS = 30_000;

/** Interval between worker-level Redis heartbeat updates (ms). */
const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;

/** Maximum consecutive heartbeat failures before declaring crash. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Timeout for a single vsock heartbeat ping (ms). */
const HEARTBEAT_PING_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MonitoredWorkspace {
  workspaceId: string;
  vsockSocketPath: string;
  vmId: string;
  interval: NodeJS.Timeout;
  consecutiveFailures: number;
}

// ---------------------------------------------------------------------------
// WorkspaceHeartbeat class
// ---------------------------------------------------------------------------

export class WorkspaceHeartbeat {
  private monitors = new Map<string, MonitoredWorkspace>();
  private workerHeartbeatTimer: NodeJS.Timeout | null = null;

  /**
   * Start monitoring a workspace VM via periodic vsock heartbeat pings.
   *
   * Every WORKSPACE_HEARTBEAT_INTERVAL_MS, sends `echo heartbeat` via vsock.
   * On success, updates lastHeartbeatAt in Redis and resets the failure counter.
   * After MAX_CONSECUTIVE_FAILURES consecutive failures, reports crash and
   * destroys the workspace.
   */
  startMonitoring(
    workspaceId: string,
    vsockSocketPath: string,
    vmId: string,
  ): void {
    // Don't double-monitor
    if (this.monitors.has(workspaceId)) {
      logger.debug("Already monitoring workspace heartbeat", { workspaceId });
      return;
    }

    logger.info("Starting heartbeat monitoring for workspace", {
      workspaceId,
      vmId,
    });

    const interval = setInterval(async () => {
      const monitor = this.monitors.get(workspaceId);
      if (!monitor) return;

      try {
        const result = await vsockExec(
          vsockSocketPath,
          "echo heartbeat",
          HEARTBEAT_PING_TIMEOUT_MS,
        );

        if (result.exitCode === 0 && result.stdout.trim() === "heartbeat") {
          // Success — reset failures and update Redis
          monitor.consecutiveFailures = 0;
          await sessionStore.updateHeartbeat(workspaceId).catch((err) => {
            logger.warn("Failed to update heartbeat in Redis", {
              workspaceId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        } else {
          // Unexpected response — count as failure
          monitor.consecutiveFailures++;
          logger.warn("Workspace heartbeat unexpected response", {
            workspaceId,
            vmId,
            exitCode: result.exitCode,
            stdout: result.stdout.slice(0, 100),
            consecutiveFailures: monitor.consecutiveFailures,
          });
        }
      } catch (err) {
        monitor.consecutiveFailures++;
        logger.warn("Workspace heartbeat ping failed", {
          workspaceId,
          vmId,
          consecutiveFailures: monitor.consecutiveFailures,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Check if we've exceeded the failure threshold
      if (monitor.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error("Workspace heartbeat failed — declaring crash", {
          workspaceId,
          vmId,
          consecutiveFailures: monitor.consecutiveFailures,
        });

        // Stop monitoring first to prevent re-entry
        this.stopMonitoring(workspaceId);

        // Handle the crash asynchronously
        await this.handleWorkspaceCrash(workspaceId, vmId).catch((crashErr) => {
          logger.error("Error handling workspace crash", {
            workspaceId,
            error:
              crashErr instanceof Error
                ? crashErr.message
                : String(crashErr),
          });
        });
      }
    }, WORKSPACE_HEARTBEAT_INTERVAL_MS);

    this.monitors.set(workspaceId, {
      workspaceId,
      vsockSocketPath,
      vmId,
      interval,
      consecutiveFailures: 0,
    });
  }

  /**
   * Stop monitoring a specific workspace.
   */
  stopMonitoring(workspaceId: string): void {
    const monitor = this.monitors.get(workspaceId);
    if (monitor) {
      clearInterval(monitor.interval);
      this.monitors.delete(workspaceId);
      logger.debug("Stopped heartbeat monitoring", { workspaceId });
    }
  }

  /**
   * Stop all workspace heartbeat monitors and the worker heartbeat.
   * Call this during graceful shutdown.
   */
  stopAll(): void {
    for (const [workspaceId, monitor] of this.monitors) {
      clearInterval(monitor.interval);
      logger.debug("Stopped heartbeat monitoring", { workspaceId });
    }
    this.monitors.clear();

    if (this.workerHeartbeatTimer) {
      clearInterval(this.workerHeartbeatTimer);
      this.workerHeartbeatTimer = null;
      logger.debug("Stopped worker heartbeat");
    }
  }

  /**
   * Start the worker-level heartbeat loop.
   *
   * Updates the `worker:heartbeat:{instanceId}` key in Redis every
   * WORKER_HEARTBEAT_INTERVAL_MS with a 30-second TTL. If this worker
   * crashes, the key expires and other workers can detect the orphaned
   * sessions during their recovery scan.
   */
  startWorkerHeartbeat(instanceId: string): void {
    if (this.workerHeartbeatTimer) {
      clearInterval(this.workerHeartbeatTimer);
    }

    logger.info("Starting worker heartbeat", { instanceId });

    // Set immediately on start
    sessionStore.setWorkerHeartbeat(instanceId).catch((err) => {
      logger.error("Failed to set initial worker heartbeat", {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.workerHeartbeatTimer = setInterval(async () => {
      try {
        await sessionStore.setWorkerHeartbeat(instanceId);
      } catch (err) {
        logger.error("Failed to update worker heartbeat", {
          instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, WORKER_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Get the number of currently monitored workspaces.
   */
  get monitoredCount(): number {
    return this.monitors.size;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Handle a workspace that has been declared crashed after consecutive
   * heartbeat failures. Fetches the session from Redis, reports the crash,
   * and destroys the VM.
   */
  private async handleWorkspaceCrash(
    workspaceId: string,
    vmId: string,
  ): Promise<void> {
    const session = await sessionStore.get(workspaceId);
    if (!session) {
      logger.warn("Crashed workspace session not found in Redis", {
        workspaceId,
      });
      return;
    }

    // Report crash
    await reportCrash({
      workspaceId,
      bountyId: session.bountyId,
      agentId: session.agentId,
      claimId: session.claimId,
      vmId,
      workerInstanceId: session.workerInstanceId,
      crashType: "vm_unresponsive",
      errorMessage: `VM failed ${MAX_CONSECUTIVE_FAILURES} consecutive heartbeat pings`,
      lastKnownStatus: session.status,
      recovered: false,
      recoveryAction: "abandoned",
    });

    // Destroy the VM
    try {
      const handle: VMHandle = {
        vmId,
        jobId: workspaceId,
        // Use the real guest IP so releaseGuestIp returns it to the pool.
        // Falling back to 0.0.0.0 only if session lacks guestIp (shouldn't happen).
        guestIp: session.guestIp ?? "0.0.0.0",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
      };

      // Attach internal metadata for destroyFirecrackerVM
      const internal = handle as unknown as Record<string, unknown>;
      internal.__tapDevice = session.tapDevice;
      internal.__overlayPath = session.overlayPath;
      internal.__vsockSocketPath = session.vsockSocketPath;
      internal.__firecrackerPid = session.firecrackerPid;

      await destroyFirecrackerVM(handle);
    } catch (err) {
      logger.error("Failed to destroy crashed VM", {
        workspaceId,
        vmId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Update Redis
    await sessionStore.updateStatus(workspaceId, "destroyed").catch(() => {});

    // Clean up after a delay (matching sessionManager pattern)
    setTimeout(async () => {
      await sessionStore.delete(workspaceId).catch(() => {});
    }, 5 * 60 * 1000);
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const workspaceHeartbeat = new WorkspaceHeartbeat();
