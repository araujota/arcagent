/**
 * Crash report submission to the Convex backend.
 *
 * When a workspace VM crashes, becomes unresponsive, or is orphaned after
 * a worker restart, this module submits a structured crash report to Convex
 * for observability and agent notification.
 *
 * The report is POSTed to the Convex HTTP endpoint with WORKER_SHARED_SECRET
 * bearer auth. If the POST fails (network issue, Convex down), the error is
 * logged locally as a fallback — crash reports are best-effort.
 */

import os from "node:os";
import { logger } from "../index";
import { sessionStore } from "./sessionStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrashReportParams {
  workspaceId: string;
  bountyId: string;
  agentId: string;
  claimId: string;
  vmId: string;
  workerInstanceId: string;
  crashType:
    | "vm_process_exited"
    | "vm_unresponsive"
    | "worker_restart"
    | "oom_killed"
    | "disk_full"
    | "provision_failed"
    | "vsock_error"
    | "network_error"
    | "timeout"
    | "unknown";
  errorMessage: string;
  lastKnownStatus: string;
  recovered: boolean;
  recoveryAction?: "reconnected" | "reprovisioned" | "abandoned";
}

interface CrashReportPayload extends CrashReportParams {
  hostMetrics: {
    totalActiveVMs: number;
    hostMemoryUsedPercent: number;
    hostCpuUsedPercent: number;
  };
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Submit a crash report to the Convex backend.
 *
 * Collects host-level metrics (free memory, load average, active VM count)
 * and POSTs to the workspace crash-report endpoint. Falls back to
 * logger.error if the HTTP request fails.
 */
export async function reportCrash(params: CrashReportParams): Promise<void> {
  const convexUrl = process.env.CONVEX_URL;
  const workerSecret = process.env.WORKER_SHARED_SECRET;

  // Collect host metrics
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const hostMemoryUsedPercent = Math.round(
    ((totalMem - freeMem) / totalMem) * 100,
  );
  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length || 1;
  const hostCpuUsedPercent = Math.round((loadAvg[0] / cpuCount) * 100);

  // Count active VMs from Redis
  let totalActiveVMs = 0;
  try {
    const activeSessions = await sessionStore.listActive();
    totalActiveVMs = activeSessions.length;
  } catch {
    // Non-critical — use 0 as fallback
  }

  const payload: CrashReportPayload = {
    ...params,
    hostMetrics: {
      totalActiveVMs,
      hostMemoryUsedPercent,
      hostCpuUsedPercent,
    },
    createdAt: Date.now(),
  };

  // Always log locally first
  logger.error("Workspace crash detected", {
    workspaceId: params.workspaceId,
    vmId: params.vmId,
    crashType: params.crashType,
    recovered: params.recovered,
    recoveryAction: params.recoveryAction,
    errorMessage: params.errorMessage,
  });

  // POST to Convex if configured
  if (!convexUrl || !workerSecret) {
    logger.warn("Cannot submit crash report: CONVEX_URL or WORKER_SHARED_SECRET not configured");
    return;
  }

  const url = `${convexUrl.replace(/\/+$/, "")}/api/workspace/crash-report`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerSecret}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        logger.info("Crash report submitted to Convex", {
          workspaceId: params.workspaceId,
          crashType: params.crashType,
        });
        return;
      }

      // Non-retryable client error
      if (response.status >= 400 && response.status < 500) {
        const body = await response.text().catch(() => "");
        logger.error("Convex rejected crash report (not retrying)", {
          workspaceId: params.workspaceId,
          status: response.status,
          body: body.slice(0, 300),
        });
        return;
      }

      // Server error — retry
      logger.warn("Convex returned server error for crash report", {
        workspaceId: params.workspaceId,
        status: response.status,
        attempt,
      });
    } catch (err) {
      logger.warn("Failed to submit crash report to Convex", {
        workspaceId: params.workspaceId,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Wait before retry (skip delay on last attempt)
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }

  logger.error("Exhausted retries submitting crash report — report logged locally only", {
    workspaceId: params.workspaceId,
    crashType: params.crashType,
    payload,
  });
}
