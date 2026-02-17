import express from "express";
import { createLogger, format, transports } from "winston";
import { createVerificationQueue, closeQueue } from "./queue/jobQueue";
import { createRoutes } from "./api/routes";
import { authMiddleware } from "./api/auth";
import { cleanupStaleCryptDevices } from "./vm/encryptedOverlay";
import { createWorkspaceRoutes } from "./workspace/routes";
import { destroyAllSessions, startIdleChecker, setWorkerInstanceId } from "./workspace/sessionManager";
import { vmPool } from "./vm/vmPool";
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
  const port = parseInt(process.env.PORT ?? "3001", 10);
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

  // Clean up stale dm-crypt devices from previous unclean shutdowns
  await cleanupStaleCryptDevices();

  // Initialize crash recovery: generate instance ID, recover orphans, start heartbeat
  const instanceId = generateWorkerInstanceId();
  setWorkerInstanceId(instanceId);
  logger.info("Worker instance ID generated", { instanceId });

  await recoverOrphanedSessions(instanceId);
  workspaceHeartbeat.startWorkerHeartbeat(instanceId);

  // Initialise the BullMQ queue & worker
  const { queue, worker } = await createVerificationQueue(redisUrl);

  logger.info("BullMQ queue and worker initialised", {
    redisUrl: redisUrl.replace(/\/\/.*@/, "//<redacted>@"),
  });

  // Express app
  const app = express();
  // 12 MB limit to accommodate diff patches (up to 10 MiB) with overhead
  app.use(express.json({ limit: "12mb" }));

  // Health endpoint is unauthenticated
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
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
  vmPool.initialize().catch((err) => {
    logger.warn("Warm VM pool initialization failed", { error: String(err) });
  });

  const server = app.listen(port, () => {
    logger.info(`Worker API server listening on port ${port}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal} – shutting down gracefully`);
    server.close();
    workspaceHeartbeat.stopAll();
    await destroyAllSessions();
    await vmPool.drainAll();
    await worker.close();
    await closeQueue(queue);
    await sessionStore.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("Fatal startup error", err);
  process.exit(1);
});
