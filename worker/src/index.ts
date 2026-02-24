import express from "express";
import { createLogger, format, transports } from "winston";
import { existsSync, readdirSync } from "node:fs";
import { createVerificationQueue, closeQueue } from "./queue/jobQueue";
import { createRoutes } from "./api/routes";
import { authMiddleware } from "./api/auth";
import { cleanupStaleCryptDevices } from "./vm/encryptedOverlay";
import { cleanupStaleResources } from "./vm/hostCleanup";
import { createWorkspaceRoutes } from "./workspace/routes";
import { destroyAllSessions, startIdleChecker, setWorkerInstanceId } from "./workspace/sessionManager";
import { vmPool } from "./vm/vmPool";
import { vsockPool } from "./vm/vsockChannel";
import { generateWorkerInstanceId, recoverOrphanedSessions } from "./workspace/recovery";
import { workspaceHeartbeat } from "./workspace/heartbeat";
import { sessionStore } from "./workspace/sessionStore";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json(),
  ),
  defaultMeta: { service: "arcagent-worker" },
  transports: [
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    }),
  ],
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // Startup validation — crash immediately if misconfigured
  // -------------------------------------------------------------------------
  const requiredEnvVars = ["WORKER_SHARED_SECRET"] as const;
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      logger.error("Missing required environment variable", { envVar });
      process.exit(1);
    }
  }

  const port = parseInt(process.env.PORT ?? "3001", 10);
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const executionBackend = (process.env.WORKER_EXECUTION_BACKEND ?? "firecracker").toLowerCase();

  // -------------------------------------------------------------------------
  // Startup cleanup — remove orphaned resources from prior unclean shutdowns
  // -------------------------------------------------------------------------
  if (executionBackend === "firecracker") {
    await cleanupStaleCryptDevices();
    await cleanupStaleResources();
  }

  // Initialize crash recovery: generate instance ID, recover orphans, start heartbeat
  const instanceId = generateWorkerInstanceId();
  setWorkerInstanceId(instanceId);
  logger.info("Worker instance ID generated", { instanceId });

  await recoverOrphanedSessions(instanceId);
  workspaceHeartbeat.startWorkerHeartbeat(instanceId);

  // Initialise the BullMQ queue & worker
  const { queue, worker, queueEvents } = await createVerificationQueue(redisUrl);

  logger.info("BullMQ queue and worker initialised", {
    redisUrl: redisUrl.replace(/\/\/.*@/, "//<redacted>@"),
  });

  // Express app
  const app = express();
  // 12 MB limit to accommodate diff patches (up to 10 MiB) with overhead
  app.use(express.json({ limit: "12mb" }));

  // Health endpoint — deep check of critical dependencies
  app.get("/api/health", async (_req, res) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    // Redis
    try {
      await sessionStore.ping();
      checks.redis = "ok";
    } catch {
      checks.redis = "error";
      healthy = false;
    }

    checks.executionBackend = executionBackend;

    if (executionBackend === "firecracker") {
      // Firecracker binary
      const fcBin = process.env.FIRECRACKER_BIN ?? "/usr/local/bin/firecracker";
      checks.firecracker = existsSync(fcBin) ? "ok" : "missing";
      if (checks.firecracker !== "ok") healthy = false;

      // Kernel image
      const kernel = process.env.FC_KERNEL_IMAGE ?? "/var/lib/firecracker/vmlinux";
      checks.kernel = existsSync(kernel) ? "ok" : "missing";
      if (checks.kernel !== "ok") healthy = false;

      // Rootfs directory (check at least one .ext4 exists)
      const rootfsDir = process.env.FC_ROOTFS_DIR ?? "/var/lib/firecracker/rootfs";
      try {
        const files = readdirSync(rootfsDir).filter(f => f.endsWith(".ext4"));
        checks.rootfs = files.length > 0 ? "ok" : "empty";
        if (checks.rootfs !== "ok") healthy = false;
      } catch {
        checks.rootfs = "missing";
        healthy = false;
      }
    }

    const status = healthy ? 200 : 503;
    res.status(status).json({
      status: healthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
    });
  });

  // All other API routes require shared-secret auth
  app.use("/api", authMiddleware);

  // Mount route handlers
  const routes = createRoutes(queue);
  app.use("/api", routes);

  // Mount workspace routes (dev VM lifecycle)
  const workspaceRoutes = createWorkspaceRoutes();
  app.use("/api", workspaceRoutes);

  // Start idle workspace checker
  startIdleChecker();

  // Initialize warm VM pool (background, non-blocking)
  if (executionBackend === "firecracker") {
    vmPool.initialize().catch((err) => {
      logger.warn("Warm VM pool initialization failed", { error: String(err) });
    });
  }

  const server = app.listen(port, () => {
    logger.info("Worker API server listening", { port });
  });

  // Graceful shutdown — correct ordering with safety timeout
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // idempotent
    shuttingDown = true;

    logger.info("Received signal, shutting down gracefully", { signal });

    // Safety net: force exit after 30s if graceful shutdown hangs
    const forceTimer = setTimeout(() => {
      logger.error("Graceful shutdown timed out after 30s — forcing exit");
      process.exit(1);
    }, 30_000);
    forceTimer.unref();

    // 1. Stop accepting new connections
    server.close();

    // 2. Stop heartbeat intervals
    workspaceHeartbeat.stopAll();

    // 3. Drain BullMQ worker FIRST — waits for in-flight jobs to finish
    //    (their finally blocks will destroy verification VMs)
    await worker.close().catch((err) => {
      logger.error("BullMQ worker close failed", { error: String(err) });
    });

    // 4. Now destroy workspace sessions (dev VMs)
    await destroyAllSessions();

    // 5. Drain warm pool and close vsock connections
    await vmPool.drainAll();
    vsockPool.destroyAll();

    // 6. Close queue, queue events, and Redis
    await queueEvents.close().catch(() => {});
    await closeQueue(queue);
    await sessionStore.close();

    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ---------------------------------------------------------------------------
// Process-level error handlers — critical for long-lived workers
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  // Do NOT exit — log and continue. Most unhandled rejections are from
  // fire-and-forget cleanup code that already has fallbacks.
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception — exiting", {
    error: err.message,
    stack: err.stack,
  });
  // Uncaught exceptions leave the process in an undefined state.
  // Exit so systemd can restart with a clean slate.
  process.exit(1);
});

main().catch((err) => {
  logger.error("Fatal startup error", err);
  process.exit(1);
});
