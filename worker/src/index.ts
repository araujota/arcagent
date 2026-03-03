import express from "express";
import { execFileSync } from "node:child_process";
import { createLogger, format, transports } from "winston";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createVerificationQueueWithMode, closeQueue } from "./queue/jobQueue";
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
import { execFileAsync } from "./lib/execFileAsync";
import { getSupportedLanguages, getVMConfig } from "./vm/vmConfig";

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
  const workerRoleRaw = (process.env.WORKER_ROLE ?? "api").toLowerCase();
  if (workerRoleRaw !== "api") {
    logger.error("Invalid WORKER_ROLE for hard API-only deployment. Set WORKER_ROLE=api.", {
      workerRole: workerRoleRaw,
    });
    process.exit(1);
  }
  const workerRole = "api";
  // API workers must consume verification jobs. If this is false, /api/verify
  // will enqueue work that never leaves BullMQ "wait".
  const runsQueue = true;
  const runsWorkspace = true;
  const hasLocalExecution = runsQueue || runsWorkspace;
  const executionBackend = (process.env.WORKER_EXECUTION_BACKEND ?? "process").toLowerCase();
  const isProduction = process.env.NODE_ENV === "production";
  const supportedBackends = new Set(["firecracker", "process"]);

  if (hasLocalExecution && !supportedBackends.has(executionBackend)) {
    logger.error("Unsupported execution backend", {
      executionBackend,
      supportedBackends: Array.from(supportedBackends),
    });
    process.exit(1);
  }

  if (hasLocalExecution && executionBackend === "firecracker" && isProduction && process.env.FC_HARDEN_EGRESS !== "true") {
    logger.error("FC_HARDEN_EGRESS must be true in production firecracker mode");
    process.exit(1);
  }

  if (hasLocalExecution && executionBackend === "process") {
    const requiredTools: string[] = [];
    if (process.env.SNYK_TOKEN) requiredTools.push("snyk");
    if (process.env.SONARQUBE_URL && process.env.SONARQUBE_TOKEN) requiredTools.push("sonar-scanner");
    for (const tool of requiredTools) {
      if (!hasBinary(tool)) {
        logger.error("Required scanner binary missing", { tool, executionBackend });
        process.exit(1);
      }
    }
  }

  if (hasLocalExecution && executionBackend === "firecracker" && process.env.SCANNER_GLOBAL_ENFORCEMENT === "true") {
    const rootfsDir = process.env.FC_ROOTFS_DIR ?? "/var/lib/firecracker/rootfs";
    const coverage = evaluateScannerCoverageByImageClass(rootfsDir);
    if (coverage.missingImages.length > 0) {
      logger.error("Global scanner enforcement enabled with incomplete rootfs coverage", {
        rootfsDir,
        missingImages: coverage.missingImages,
        requiredImages: coverage.requiredImages,
      });
      process.exit(1);
    }
  }

  // -------------------------------------------------------------------------
  // Startup cleanup — remove orphaned resources from prior unclean shutdowns
  // -------------------------------------------------------------------------
  if (hasLocalExecution && executionBackend === "firecracker") {
    await cleanupStaleCryptDevices();
    await cleanupStaleResources();
  }

  if (hasLocalExecution) {
    // Initialize crash recovery: generate instance ID, recover orphans, start heartbeat
    const instanceId = generateWorkerInstanceId();
    setWorkerInstanceId(instanceId);
    logger.info("Worker instance ID generated", { instanceId });

    await recoverOrphanedSessions(instanceId);
    workspaceHeartbeat.startWorkerHeartbeat(instanceId);
  }

  // Initialise the BullMQ queue & worker
  const { queue, worker, queueEvents } = await createVerificationQueueWithMode(redisUrl, {
    processJobs: runsQueue,
  });

  logger.info("BullMQ queue and worker initialised", {
    workerRole,
    runsQueue,
    runsWorkspace,
    redisUrl: redisUrl.replace(/\/\/.*@/, "//<redacted>@"),
  });
  logger.info("Execution backend lock state", {
    executionBackend,
    firecrackerLocked: executionBackend === "firecracker",
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

    checks.workerRole = workerRole;
    checks.verificationQueueConsumer = runsQueue ? "enabled" : "disabled";
    checks.localExecution = hasLocalExecution ? "enabled" : "disabled";
    checks.workspaceMode = runsWorkspace ? "local" : "external_only";
    checks.executionBackend = executionBackend;
    checks.firecrackerLocked = executionBackend === "firecracker" ? "true" : "false";
    checks.executionIsolation = executionBackend === "firecracker" ? "microvm_rootfs" : "process_sandbox";
    checks.workerHostRuntime = "ok";
    checks.snykCli = hasBinary("snyk") ? "ok" : "missing";
    checks.sonarScanner = hasBinary("sonar-scanner") ? "ok" : "missing";

    if (!hasLocalExecution) {
      checks.executionBackendPolicy = "external_executor_required";
      checks.firecrackerLocked = "not_applicable";
      checks.executionIsolation = "external_executor";
    } else {
      if (!supportedBackends.has(executionBackend)) {
        checks.executionBackendPolicy = "violation";
        healthy = false;
      } else {
        checks.executionBackendPolicy = "ok";
      }

      if (executionBackend === "process" && process.env.SNYK_TOKEN && checks.snykCli !== "ok") {
        healthy = false;
      }
      if (
        executionBackend === "process" &&
        process.env.SONARQUBE_URL &&
        process.env.SONARQUBE_TOKEN &&
        checks.sonarScanner !== "ok"
      ) {
        healthy = false;
      }

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
        checks.rootfsPath = rootfsDir;
        try {
          const files = readdirSync(rootfsDir).filter(f => f.endsWith(".ext4"));
          checks.rootfsDirectory = "ok";
          checks.rootfsImages = files.length > 0 ? "ok" : "empty";
          if (checks.rootfsImages !== "ok") healthy = false;

          const coverage = evaluateScannerCoverageByImageClass(rootfsDir, files);
          checks.scannerImageClassCount = String(coverage.requiredImages.length);
          checks.scannerImageCoverage = coverage.missingImages.length === 0 ? "ok" : "missing";
          checks.scannerImageMissing = coverage.missingImages.join(",") || "none";
          checks.scannerGlobalEnforcement = process.env.SCANNER_GLOBAL_ENFORCEMENT === "true" ? "enabled" : "disabled";
          if (process.env.SCANNER_GLOBAL_ENFORCEMENT === "true" && coverage.missingImages.length > 0) {
            healthy = false;
          }
        } catch {
          checks.rootfsDirectory = "missing";
          checks.rootfsImages = "unknown";
          checks.scannerImageCoverage = "unknown";
          checks.scannerImageMissing = "unknown";
          checks.scannerGlobalEnforcement = process.env.SCANNER_GLOBAL_ENFORCEMENT === "true" ? "enabled" : "disabled";
          healthy = false;
        }

        checks.kvmDevice = existsSync("/dev/kvm") ? "ok" : "missing";
        if (checks.kvmDevice !== "ok") healthy = false;

        checks.vhostVsockDevice = existsSync("/dev/vhost-vsock") ? "ok" : "missing";
        if (checks.vhostVsockDevice !== "ok") healthy = false;
        checks.firecrackerLaunchMode = process.env.FC_USE_JAILER === "false" ? "direct" : "jailer";

        const jailerUid = process.env.FC_JAILER_UID ?? "1001";
        const jailerGid = process.env.FC_JAILER_GID ?? "1001";
        checks.jailerUid = jailerUid;
        checks.jailerGid = jailerGid;

        const encryptedRootfsSamplePath = resolveEncryptedRootfsSamplePath();
        checks.encryptedRootfsSamplePath = encryptedRootfsSamplePath ?? "none";
        checks.jailerCanReadEncryptedRootfsSample = evaluateReadabilityForIdentity(
          encryptedRootfsSamplePath,
          jailerUid,
          jailerGid,
        );
        if (
          checks.jailerCanReadEncryptedRootfsSample.startsWith("permission_denied") ||
          checks.jailerCanReadEncryptedRootfsSample.startsWith("stat_failed") ||
          checks.jailerCanReadEncryptedRootfsSample.startsWith("invalid_jailer_identity")
        ) {
          healthy = false;
        }
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

  const workspaceRoutes = createWorkspaceRoutes();
  app.use("/api", workspaceRoutes);

  // API-only mode: no local workspace checker.
  if (runsWorkspace) {
    startIdleChecker();
  }

  // Initialize warm VM pool (background, non-blocking)
  if (runsWorkspace && executionBackend === "firecracker") {
    vmPool.initialize().catch((err) => {
      logger.warn("Warm VM pool initialization failed", { error: String(err) });
    });
  }

  const server = app.listen(port, () => {
    logger.info("Worker API server listening", { port });
  });
  const stopWatchdog = startSystemdWatchdog();

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
    if (runsWorkspace) {
      workspaceHeartbeat.stopAll();
    }
    stopWatchdog();

    // 3. Drain BullMQ worker FIRST — waits for in-flight jobs to finish
    //    (their finally blocks will destroy verification VMs)
    if (worker) {
      await worker.close().catch((err) => {
        logger.error("BullMQ worker close failed", { error: String(err) });
      });
    }

    // 4. Now destroy workspace sessions (dev VMs)
    if (runsWorkspace) {
      await destroyAllSessions();
    }

    // 5. Drain warm pool and close vsock connections
    if (runsWorkspace) {
      await vmPool.drainAll();
      vsockPool.destroyAll();
    }

    // 6. Close queue, queue events, and Redis
    if (queueEvents) {
      await queueEvents.close().catch(() => {});
    }
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

function hasBinary(binary: string): boolean {
  try {
    execFileSync("bash", ["-lc", `command -v ${binary} >/dev/null 2>&1`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function startSystemdWatchdog(): () => void {
  const notifySocket = process.env.NOTIFY_SOCKET;
  if (!notifySocket) return () => {};

  const watchdogUsec = parseInt(process.env.WATCHDOG_USEC ?? "0", 10);
  const watchdogIntervalMs = watchdogUsec > 0
    ? Math.max(Math.floor(watchdogUsec / 2_000), 1_000)
    : 0;

  let disabled = false;
  let timer: NodeJS.Timeout | null = null;

  const notify = async (args: string[]): Promise<void> => {
    if (disabled) return;
    try {
      await execFileAsync("systemd-notify", args, { timeout: 5_000 });
    } catch (err) {
      disabled = true;
      logger.warn("Failed to send systemd notify message; disabling watchdog pings", {
        error: String(err),
      });
    }
  };

  void notify(["--ready", "--status=arcagent-worker online"]);

  if (watchdogIntervalMs > 0) {
    timer = setInterval(() => {
      void notify(["WATCHDOG=1"]);
    }, watchdogIntervalMs);
    timer.unref();
    logger.info("Systemd watchdog heartbeat started", { watchdogIntervalMs });
  }

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    void notify(["STOPPING=1", "--status=arcagent-worker shutting down"]);
  };
}

function evaluateScannerCoverageByImageClass(
  rootfsDir: string,
  existingImages?: string[],
): {
  requiredImages: string[];
  missingImages: string[];
} {
  const requiredImages: string[] = Array.from(
    new Set<string>(getSupportedLanguages().map((language) => getVMConfig(language).rootfsImage)),
  ).sort();

  const availableImages = new Set<string>(
    existingImages ?? readdirSync(rootfsDir).filter((entry) => entry.endsWith(".ext4")),
  );

  return {
    requiredImages,
    missingImages: requiredImages.filter((image) => !availableImages.has(image)),
  };
}

function resolveEncryptedRootfsSamplePath(): string | null {
  const configured = process.env.FC_ENCRYPTED_ROOTFS_SAMPLE_PATH?.trim();
  if (configured) return configured;

  try {
    const mapperEntries = readdirSync("/dev/mapper")
      .filter((entry) => entry.startsWith("fc-crypt-"))
      .sort();
    if (mapperEntries.length > 0) {
      return `/dev/mapper/${mapperEntries[0]}`;
    }
  } catch {
    // /dev/mapper may not exist in local development.
  }

  return null;
}

function evaluateReadabilityForIdentity(
  samplePath: string | null,
  jailerUidRaw: string,
  jailerGidRaw: string,
): string {
  if (!samplePath) return "unknown_no_sample_device";
  if (!existsSync(samplePath)) return "sample_missing";
  if (!/^\d+$/.test(jailerUidRaw) || !/^\d+$/.test(jailerGidRaw)) {
    return "invalid_jailer_identity";
  }

  const jailerUid = parseInt(jailerUidRaw, 10);
  const jailerGid = parseInt(jailerGidRaw, 10);

  try {
    const resolved = realpathSync(samplePath);
    const fsStat = statSync(resolved);
    const modeBits = fsStat.mode & 0o777;
    const mode = modeBits.toString(8).padStart(3, "0");
    const readable =
      jailerUid === 0 ||
      (jailerUid === fsStat.uid && (modeBits & 0o400) !== 0) ||
      (jailerGid === fsStat.gid && (modeBits & 0o040) !== 0) ||
      (modeBits & 0o004) !== 0;
    if (readable) return "ok";

    return `permission_denied(mode=${mode},owner=${fsStat.uid}:${fsStat.gid},resolved=${resolved})`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `stat_failed(${message})`;
  }
}
