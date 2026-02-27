import { execFile } from "node:child_process";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../index";
import { vsockExec, vsockExecWithStdin, vsockWriteFile, waitForVsock, sendVsockRequestPooled, VsockRequest, VsockResponse, vsockPool } from "./vsockChannel";
import { createEncryptedOverlay, destroyEncryptedOverlay, EncryptedOverlayHandle } from "./encryptedOverlay";
import { startDnsResolver, stopDnsResolver, applyDnsRedirect, removeDnsRedirect, DnsResolverHandle } from "./dnsPolicy";
import { startEgressProxy, stopEgressProxy, applyProxyRedirect, removeProxyRedirect, applyRateLimiting, removeRateLimiting, EgressProxyHandle } from "./egressProxy";
import { getVMConfig } from "./vmConfig";
import { createProcessVM, destroyProcessVM, isProcessHandle } from "./processBackend";
import { execFileAsync } from "../lib/execFileAsync";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for creating a new Firecracker microVM. */
export interface FirecrackerVMOptions {
  jobId: string;
  rootfsImage: string;
  vcpuCount: number;
  memSizeMib: number;
}

/**
 * Handle representing a running microVM.  Provides methods to execute
 * commands inside the VM and to tear it down.
 */
export interface VMHandle {
  /** Unique identifier for the VM instance. */
  vmId: string;
  /** The job ID that owns this VM. */
  jobId: string;
  /** IP address of the VM on the host-side tap interface. */
  guestIp: string;
  /** Execute a shell command inside the guest via vsock (or SSH fallback). */
  exec(command: string, timeoutMs?: number, user?: string): Promise<ExecResult>;
  /** Execute a command with stdin piped via vsock. */
  execWithStdin?(command: string, stdin: string, timeoutMs?: number, user?: string): Promise<ExecResult>;
  /** Write a file inside the guest via vsock. */
  writeFile?(path: string, content: Buffer, mode?: string, owner?: string): Promise<void>;
  /** Send a raw vsock request (for file_edit, file_glob, file_grep, session_* operations). */
  vsockRequest?(request: import("./vsockChannel").VsockRequest): Promise<import("./vsockChannel").VsockResponse>;
}

/** Result of executing a command inside the VM. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface FirecrackerProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  processError?: string;
}

interface RootfsReadabilityCheck {
  readable: boolean;
  reason: "ok" | "permission_denied" | "stat_failed" | "invalid_jailer_identity";
  path: string;
  resolvedPath: string;
  jailerUid: string;
  jailerGid: string;
  mode?: string;
  ownerUid?: number;
  ownerGid?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIRECRACKER_BIN =
  process.env.FIRECRACKER_BIN ?? "/usr/local/bin/firecracker";
const JAILER_BIN = process.env.JAILER_BIN ?? "/usr/local/bin/jailer";
const KERNEL_IMAGE =
  process.env.FC_KERNEL_IMAGE ?? "/var/lib/firecracker/vmlinux";
const ROOTFS_DIR =
  process.env.FC_ROOTFS_DIR ?? "/var/lib/firecracker/rootfs";
/** UID/GID for jailer. Reads from env (set by setup-host.sh) or defaults to 1001. */
const JAILER_UID = process.env.FC_JAILER_UID ?? "1001";
const JAILER_GID = process.env.FC_JAILER_GID ?? "1001";
const TAP_PREFIX = "fc-tap-";
const DEFAULT_EXEC_TIMEOUT_MS = 120_000; // 2 minutes
/** Enable vsock-based communication (set to "false" to fall back to SSH). */
const USE_VSOCK = process.env.FC_USE_VSOCK !== "false";
/** Launch through jailer by default; set FC_USE_JAILER=false to run Firecracker directly. */
const USE_JAILER = process.env.FC_USE_JAILER !== "false";
/** Vsock guest init path inside rootfs (can be overridden for compatibility). */
const DEFAULT_VSOCK_INIT_PATH = process.env.FC_VSOCK_INIT_PATH ?? "/usr/local/bin/vsock-agent";
/** Reject tiny placeholder scripts when validating rootfs vsock agent binaries. */
const MIN_VSOCK_AGENT_BYTES = parseInt(process.env.FC_MIN_VSOCK_AGENT_BYTES ?? "32768", 10);
/** SSH key path for SSH fallback (when vsock is disabled). */
const SSH_KEY_PATH = process.env.FC_SSH_KEY_PATH ?? "/root/.ssh/id_ed25519";
/** SSH port on guest (when vsock is disabled). */
const GUEST_SSH_PORT = parseInt(process.env.FC_GUEST_SSH_PORT ?? "22", 10);
const EXECUTION_BACKEND = (process.env.WORKER_EXECUTION_BACKEND ?? "firecracker").toLowerCase();
const ALLOW_UNSAFE_PROCESS_BACKEND =
  process.env.NODE_ENV !== "production" && process.env.ALLOW_UNSAFE_PROCESS_BACKEND === "true";

// ---------------------------------------------------------------------------
// VM lifecycle
// ---------------------------------------------------------------------------

/**
 * Create and boot a Firecracker microVM.
 *
 * Steps:
 *  1. Allocate a unique VM ID and networking resources (tap device, IP).
 *  2. Copy the rootfs image to an ephemeral overlay so the base stays clean.
 *  3. Launch Firecracker through the jailer for sandboxing.
 *  4. Wait until SSH inside the guest is reachable.
 *  5. Return a VMHandle for running commands and tearing down.
 */
export async function createFirecrackerVM(
  opts: FirecrackerVMOptions,
): Promise<VMHandle> {
  if (EXECUTION_BACKEND === "process") {
    if (!ALLOW_UNSAFE_PROCESS_BACKEND) {
      throw new Error(
        "Process backend is disabled for deployed runtimes. " +
        "Use WORKER_EXECUTION_BACKEND=firecracker, or set ALLOW_UNSAFE_PROCESS_BACKEND=true in local non-production only.",
      );
    }
    return createProcessVM(opts);
  }

  const vmId = `vm-${uuidv4().slice(0, 8)}`;
  const tapDevice = `${TAP_PREFIX}${vmId.slice(3)}`;
  const network = allocateVmNetwork(vmId);
  const guestIp = network.guestIp;
  const gatewayIp = network.gatewayIp;
  const vsockSocketPath = `/tmp/fc-vsock-${vmId}.sock`;

  logger.info("Creating Firecracker microVM", {
    vmId,
    jobId: opts.jobId,
    vcpuCount: opts.vcpuCount,
    memSizeMib: opts.memSizeMib,
    rootfsImage: opts.rootfsImage,
    useVsock: USE_VSOCK,
  });

  let dnsResolver: DnsResolverHandle | null = null;
  let egressProxy: EgressProxyHandle | null = null;
  let overlayPath = "";
  let overlayType: "encrypted" | "unencrypted" = "unencrypted";
  let encryptedOverlay: EncryptedOverlayHandle | null = null;
  let vmSshKeyPath: string | undefined;
  let configPath: string | undefined;
  let firecrackerPid: number | undefined;
  let vmProcessRef: Promise<FirecrackerProcessExit> | undefined;

  try {

  // 1. Create TAP device (kept solely for outbound internet: git clone, npm install)
  await execFileAsync("ip", [
    "tuntap",
    "add",
    tapDevice,
    "mode",
    "tap",
  ]).catch((err) => {
    logger.warn("TAP device creation failed (may already exist)", {
      vmId,
      error: String(err),
    });
  });

  await execFileAsync("ip", ["addr", "add", `${gatewayIp}/30`, "dev", tapDevice]);
  await execFileAsync("ip", ["link", "set", tapDevice, "up"]);

  // SECURITY (P2-1): Apply iptables egress filtering on the TAP device.
  await applyEgressFiltering(tapDevice);

  // Hardened egress: DNS resolver + SNI proxy + rate limiting (if enabled)
  const vmConfig = getVMConfig(opts.rootfsImage.replace(/\.ext4$/, "").replace(/-\d+$/, ""));
  const allowedDomains = buildAllowedDomains(vmConfig.allowedDomains);
  const hardenEgress = process.env.FC_HARDEN_EGRESS !== "false"
    && (process.env.FC_HARDEN_EGRESS === "true" || process.env.NODE_ENV === "production");

  if (hardenEgress && allowedDomains.length > 0) {
    try {
      dnsResolver = await startDnsResolver(vmId, gatewayIp, allowedDomains);
      await applyDnsRedirect(tapDevice, gatewayIp);
      egressProxy = await startEgressProxy(vmId, allowedDomains);
      await applyProxyRedirect(tapDevice, egressProxy.port);
      await applyRateLimiting(tapDevice);
      logger.info("Hardened egress applied", { vmId, domains: allowedDomains.length });
    } catch (err) {
      logger.warn("Hardened egress setup failed, cleaning partial state and using basic filtering", {
        vmId,
        error: String(err),
      });
      if (egressProxy) {
        await removeProxyRedirect(tapDevice, egressProxy.port).catch(() => {});
        await stopEgressProxy(egressProxy).catch(() => {});
        egressProxy = null;
      }
      await removeRateLimiting(tapDevice).catch(() => {});
      if (dnsResolver) {
        await removeDnsRedirect(tapDevice, gatewayIp).catch(() => {});
        await stopDnsResolver(dnsResolver).catch(() => {});
        dnsResolver = null;
      }
    }
  }

  // 2. Prepare ephemeral overlay of rootfs (with encryption if available)
  const rootfsPath = `${ROOTFS_DIR}/${opts.rootfsImage}`;

  if (USE_VSOCK) {
    // Use encrypted overlay — protects repo code from host-level access
    try {
      encryptedOverlay = await createEncryptedOverlay(vmId, rootfsPath, JAILER_UID, JAILER_GID);
      overlayPath = encryptedOverlay.devicePath;
      overlayType = "encrypted";
      logger.info("Using encrypted overlay", { vmId });
    } catch (err) {
      // Fallback to unencrypted if dm-crypt unavailable (dev environments)
      logger.warn("Encrypted overlay failed, falling back to unencrypted", {
        vmId,
        error: String(err),
      });
      overlayPath = `/tmp/fc-overlay-${vmId}.ext4`;
      await execFileAsync("cp", ["--reflink=auto", rootfsPath, overlayPath]);
      overlayType = "unencrypted";
    }
  } else {
    overlayPath = `/tmp/fc-overlay-${vmId}.ext4`;
    await execFileAsync("cp", ["--reflink=auto", rootfsPath, overlayPath]);
    overlayType = "unencrypted";
  }

  // 2a. Generate per-VM SSH keypair (only if not using vsock)
  if (!USE_VSOCK) {
    vmSshKeyPath = `/tmp/fc-ssh-${vmId}`;
    await execFileAsync("ssh-keygen", [
      "-t", "ed25519", "-f", vmSshKeyPath, "-N", "", "-q",
    ]);
  }

  // 3. Validate vsock init binary and build Firecracker config
  const vsockInitPath = USE_VSOCK ? await resolveVsockInitPath(rootfsPath) : undefined;
  const readabilityUid = USE_JAILER ? JAILER_UID : String(process.getuid?.() ?? 0);
  const readabilityGid = USE_JAILER ? JAILER_GID : String(process.getgid?.() ?? 0);
  const rootfsReadability = await checkRootfsReadableByJailer(overlayPath, readabilityUid, readabilityGid);
  logger.info("Rootfs readability check before jailer launch", {
    vmId,
    overlayType,
    rootfsPath: overlayPath,
    rootfsAccessCheck: rootfsReadability.reason,
    jailerUid: readabilityUid,
    jailerGid: readabilityGid,
    launchMode: USE_JAILER ? "jailer" : "direct",
    mode: rootfsReadability.mode,
    ownerUid: rootfsReadability.ownerUid,
    ownerGid: rootfsReadability.ownerGid,
    resolvedPath: rootfsReadability.resolvedPath,
    error: rootfsReadability.error,
  });
  if (!rootfsReadability.readable) {
    throw new Error(
      `EACCES rootfs (vmBootStage=rootfs_access_check, rootfsAccessCheck=${rootfsReadability.reason}, ` +
      `path=${rootfsReadability.path}, resolvedPath=${rootfsReadability.resolvedPath}, ` +
      `jailerUid=${readabilityUid}, jailerGid=${readabilityGid}, mode=${rootfsReadability.mode ?? "unknown"}, ` +
      `owner=${rootfsReadability.ownerUid ?? "unknown"}:${rootfsReadability.ownerGid ?? "unknown"}, ` +
      `error=${rootfsReadability.error ?? "none"})`,
    );
  }

  // Build Firecracker config (with vsock device if enabled)
  const config = buildVMConfig({
    vmId,
    kernelImage: KERNEL_IMAGE,
    rootfsPath: overlayPath,
    vcpuCount: opts.vcpuCount,
    memSizeMib: opts.memSizeMib,
    tapDevice,
    guestIp,
    gatewayIp,
    vsockSocketPath: USE_VSOCK ? vsockSocketPath : undefined,
    vsockInitPath,
  });

  configPath = `/tmp/fc-config-${vmId}.json`;
  const { writeFile, chmod } = await import("node:fs/promises");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  // Set vsock socket permissions (worker process only)
  if (USE_VSOCK) {
    // Socket will be created by Firecracker, set parent dir permissions
    // The socket itself will have restrictive permissions
  }

  // 4. Launch Firecracker (via jailer by default, direct mode for emergency compatibility)
  const launchCmd = USE_JAILER ? JAILER_BIN : FIRECRACKER_BIN;
  const launchArgs = USE_JAILER
    ? [
      "--id",
      vmId,
      "--exec-file",
      FIRECRACKER_BIN,
      "--uid",
      JAILER_UID,
      "--gid",
      JAILER_GID,
      "--",
      "--config-file",
      configPath,
      "--no-api",
    ]
    : [
      "--config-file",
      configPath,
      "--no-api",
    ];
  const fcChild = execFile(launchCmd, launchArgs);
  firecrackerPid = fcChild.pid;

  logger.info("Launching Firecracker", {
    vmId,
    launchMode: USE_JAILER ? "jailer" : "direct",
    launchCmd,
    configPath,
    overlayType,
    rootfsPath: overlayPath,
    rootfsAccessCheck: rootfsReadability.reason,
    jailerUid: readabilityUid,
    jailerGid: readabilityGid,
  });

  let firecrackerStdout = "";
  let firecrackerStderr = "";
  vmProcessRef = new Promise<FirecrackerProcessExit>((resolve) => {
    fcChild.stdout?.on("data", (d: Buffer) => { firecrackerStdout += d.toString(); });
    fcChild.stderr?.on("data", (d: Buffer) => { firecrackerStderr += d.toString(); });
    fcChild.on("close", (code, signal) => resolve({
      exitCode: code,
      signal,
      stdout: firecrackerStdout,
      stderr: firecrackerStderr,
    }));
    fcChild.on("error", (err) => resolve({
      exitCode: null,
      signal: null,
      stdout: firecrackerStdout,
      stderr: firecrackerStderr,
      processError: err.message,
    }));
  });

  // 5. Wait for communication channel
  if (USE_VSOCK) {
    try {
      const bootState = await Promise.race([
        waitForVsock(vsockSocketPath, vmId).then(() => ({ state: "ready" as const })),
        vmProcessRef!.then((exit) => ({ state: "exited" as const, exit })),
      ]);
      if (bootState.state === "exited") {
        throw buildVmBootError({
          vmId,
          vmBootStage: "vsock_wait",
          rootfsAccessCheck: rootfsReadability.reason,
          processExit: bootState.exit,
        });
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("VM boot failed for")) {
        throw err;
      }
      const earlyExit = await waitForProcessExitBriefly(vmProcessRef!, 200);
      if (earlyExit) {
        throw buildVmBootError({
          vmId,
          vmBootStage: "vsock_wait",
          rootfsAccessCheck: rootfsReadability.reason,
          processExit: earlyExit,
          cause: err,
        });
      }
      throw buildVmBootError({
        vmId,
        vmBootStage: "vsock_wait",
        rootfsAccessCheck: rootfsReadability.reason,
        cause: err,
        stdoutTail: firecrackerStdout,
        stderrTail: firecrackerStderr,
      });
    }
    // Set socket permissions to 0600
    await chmod(vsockSocketPath, 0o600).catch(() => {});
  } else {
    await waitForSSH(guestIp, vmId, vmSshKeyPath!);
  }

  logger.info("MicroVM ready", { vmId, guestIp, useVsock: USE_VSOCK });

  // Build handle
  const handle: VMHandle = {
    vmId,
    jobId: opts.jobId,
    guestIp,

    async exec(
      command: string,
      timeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS,
      user?: string,
    ): Promise<ExecResult> {
      if (USE_VSOCK) {
        return vsockExec(vsockSocketPath, command, timeoutMs, user);
      }
      return execInVM(guestIp, command, timeoutMs, vmSshKeyPath);
    },

    async execWithStdin(
      command: string,
      stdin: string,
      timeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS,
      user?: string,
    ): Promise<ExecResult> {
      if (USE_VSOCK) {
        return vsockExecWithStdin(vsockSocketPath, command, stdin, timeoutMs, user);
      }
      // SSH fallback: pipe via echo
      const escaped = Buffer.from(stdin).toString("base64");
      return execInVM(guestIp, `echo '${escaped}' | base64 -d | ${command}`, timeoutMs, vmSshKeyPath);
    },

    async writeFile(
      path: string,
      content: Buffer,
      mode?: string,
      owner?: string,
    ): Promise<void> {
      if (USE_VSOCK) {
        return vsockWriteFile(vsockSocketPath, path, content, mode, owner);
      }
      // SSH fallback: base64 pipe
      const b64 = content.toString("base64");
      await execInVM(guestIp, `echo '${b64}' | base64 -d > ${path}${mode ? ` && chmod ${mode} ${path}` : ""}${owner ? ` && chown ${owner} ${path}` : ""}`, 30_000, vmSshKeyPath);
    },

    async vsockRequest(
      request: VsockRequest,
    ): Promise<VsockResponse> {
      if (!USE_VSOCK) {
        throw new Error("vsockRequest requires FC_USE_VSOCK=true");
      }
      return sendVsockRequestPooled(vsockSocketPath, request, request.timeoutMs ?? 60_000);
    },
  };

  // Stash cleanup metadata on the handle
  (handle as VMHandleInternal).__tapDevice = tapDevice;
  (handle as VMHandleInternal).__overlayPath = encryptedOverlay ? encryptedOverlay.backingFile : overlayPath;
  (handle as VMHandleInternal).__configPath = configPath;
  (handle as VMHandleInternal).__sshKeyPath = vmSshKeyPath;
  (handle as VMHandleInternal).__processRef = vmProcessRef;
  (handle as VMHandleInternal).__firecrackerPid = firecrackerPid;
  (handle as VMHandleInternal).__vsockSocketPath = vsockSocketPath;
  (handle as VMHandleInternal).__encryptedOverlay = encryptedOverlay ?? undefined;
  (handle as VMHandleInternal).__dnsResolver = dnsResolver ?? undefined;
  (handle as VMHandleInternal).__egressProxy = egressProxy ?? undefined;

  return handle;

  } catch (err) {
    // Best-effort cleanup for partial VM creation failures.
    if (firecrackerPid) {
      await terminateFirecrackerProcess(firecrackerPid, vmProcessRef).catch(() => {});
    }
    if (egressProxy) {
      await removeProxyRedirect(tapDevice, egressProxy.port).catch(() => {});
      await stopEgressProxy(egressProxy).catch(() => {});
    }
    await removeRateLimiting(tapDevice).catch(() => {});
    if (dnsResolver) {
      await removeDnsRedirect(tapDevice, gatewayIp).catch(() => {});
      await stopDnsResolver(dnsResolver).catch(() => {});
    }
    await removeEgressFiltering(tapDevice).catch(() => {});
    await execFileAsync("ip", ["tuntap", "del", tapDevice, "mode", "tap"]).catch(() => {});

    const { unlink } = await import("node:fs/promises");
    if (encryptedOverlay) {
      await destroyEncryptedOverlay(encryptedOverlay).catch(() => {});
    } else if (overlayPath) {
      await unlink(overlayPath).catch(() => {});
    }
    if (configPath) {
      await unlink(configPath).catch(() => {});
    }
    if (vmSshKeyPath) {
      await unlink(vmSshKeyPath).catch(() => {});
      await unlink(`${vmSshKeyPath}.pub`).catch(() => {});
    }

    releaseGuestIp(guestIp);
    throw err;
  }
}

function buildAllowedDomains(baseDomains: string[]): string[] {
  const merged = new Set(baseDomains);

  if (process.env.SNYK_TOKEN) {
    merged.add("api.snyk.io");
    merged.add("app.snyk.io");
    merged.add("*.snyk.io");
  }

  const sonarUrl = process.env.SONARQUBE_URL;
  if (sonarUrl) {
    try {
      const host = new URL(sonarUrl).hostname;
      if (host) merged.add(host);
    } catch {
      // Invalid URL is handled by the SonarQube gate with a clear error.
    }
  }

  return [...merged];
}

/**
 * Tear down a Firecracker microVM and clean up all resources.
 * SECURITY (P2-4): Hardened teardown — kill by PID, verify cleanup, log warnings.
 */
export async function destroyFirecrackerVM(handle: VMHandle): Promise<void> {
  if (isProcessHandle(handle)) {
    await destroyProcessVM(handle);
    return;
  }

  const int = handle as VMHandleInternal;
  logger.info("Destroying microVM", { vmId: handle.vmId });

  // 1. Kill Firecracker process — try PID-based kill first, then pattern match as fallback
  if (int.__firecrackerPid) {
    try {
      process.kill(int.__firecrackerPid, "SIGTERM");
      // Wait briefly for graceful shutdown
      await new Promise((r) => setTimeout(r, 2_000));
      // Force kill if still alive
      try {
        process.kill(int.__firecrackerPid, 0); // Check if alive
        process.kill(int.__firecrackerPid, "SIGKILL");
      } catch {
        // Process already exited — good
      }
    } catch {
      // Process may have already exited
    }
  } else {
    // Fallback to pkill pattern matching
    try {
      await execFileAsync("pkill", ["-f", `--id ${handle.vmId}`]);
    } catch {
      // Process may have already exited
    }
  }

  // 2. Remove egress controls
  if (int.__egressProxy && int.__tapDevice) {
    await removeProxyRedirect(int.__tapDevice, int.__egressProxy.port).catch(() => {});
    await stopEgressProxy(int.__egressProxy).catch(() => {});
    await removeRateLimiting(int.__tapDevice).catch(() => {});
  }
  if (int.__dnsResolver && int.__tapDevice) {
    await removeDnsRedirect(int.__tapDevice, int.__dnsResolver.gatewayIp).catch(() => {});
    await stopDnsResolver(int.__dnsResolver).catch(() => {});
  }
  if (int.__tapDevice) {
    await removeEgressFiltering(int.__tapDevice);
  }

  // 3. Remove TAP device
  if (int.__tapDevice) {
    await execFileAsync("ip", [
      "tuntap",
      "del",
      int.__tapDevice,
      "mode",
      "tap",
    ]).catch((err) => {
      logger.warn("Failed to remove TAP device", {
        vmId: handle.vmId,
        tapDevice: int.__tapDevice,
        error: String(err),
      });
    });
  }

  // 4. Remove ephemeral files
  const { unlink } = await import("node:fs/promises");

  // Destroy encrypted overlay (wipes key from kernel memory, detaches loop, deletes file)
  if (int.__encryptedOverlay) {
    await destroyEncryptedOverlay(int.__encryptedOverlay).catch((err) => {
      logger.warn("Failed to destroy encrypted overlay", {
        vmId: handle.vmId,
        error: String(err),
      });
    });
  } else if (int.__overlayPath) {
    await unlink(int.__overlayPath).catch(() => {});
  }

  if (int.__configPath) {
    await unlink(int.__configPath).catch(() => {});
  }

  // Clean up vsock pool connections and socket file
  if (int.__vsockSocketPath) {
    vsockPool.destroy(int.__vsockSocketPath);
    await unlink(int.__vsockSocketPath).catch(() => {});
  }

  // SECURITY (P2-3): Delete per-VM SSH keypair (only if SSH was used)
  if (int.__sshKeyPath) {
    await unlink(int.__sshKeyPath).catch(() => {});
    await unlink(`${int.__sshKeyPath}.pub`).catch(() => {});
  }

  // 5. Verify TAP device is actually removed
  if (int.__tapDevice) {
    try {
      await execFileAsync("ip", ["link", "show", int.__tapDevice]);
      // If we get here, TAP still exists — warn
      logger.warn("TAP device still exists after teardown", {
        vmId: handle.vmId,
        tapDevice: int.__tapDevice,
      });
    } catch {
      // Expected: TAP device gone
    }
  }

  // Release the guest IP back to the pool
  releaseGuestIp(handle.guestIp);

  logger.info("MicroVM destroyed", { vmId: handle.vmId });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface VMHandleInternal extends VMHandle {
  __tapDevice?: string;
  __overlayPath?: string;
  __configPath?: string;
  __sshKeyPath?: string;
  __processRef?: Promise<FirecrackerProcessExit>;
  __firecrackerPid?: number;
  __vsockSocketPath?: string;
  __encryptedOverlay?: EncryptedOverlayHandle;
  __dnsResolver?: DnsResolverHandle;
  __egressProxy?: EgressProxyHandle;
}

const rootfsVsockInitCache = new Map<string, string>();
let warnedMissingDebugfs = false;

async function resolveVsockInitPath(rootfsPath: string): Promise<string> {
  if (process.env.FC_VALIDATE_VSOCK_ROOTFS === "false") {
    return DEFAULT_VSOCK_INIT_PATH;
  }

  const cached = rootfsVsockInitCache.get(rootfsPath);
  if (cached) return cached;

  const candidates = Array.from(
    new Set([DEFAULT_VSOCK_INIT_PATH, "/usr/local/bin/vsock-agent", "/usr/local/bin/guest-agent"]),
  );

  for (const path of candidates) {
    const stats = await statPathInExt4(rootfsPath, path);
    if (!stats.exists) continue;
    if (stats.size < MIN_VSOCK_AGENT_BYTES) {
      logger.warn("Rootfs contains suspiciously small vsock init candidate; rejecting", {
        rootfsPath,
        path,
        sizeBytes: stats.size,
        minBytes: MIN_VSOCK_AGENT_BYTES,
      });
      continue;
    }
    rootfsVsockInitCache.set(rootfsPath, path);
    return path;
  }

  throw new Error(
    `Rootfs ${rootfsPath} has no valid vsock init binary; expected one of: ${candidates.join(", ")}`,
  );
}

async function statPathInExt4(
  rootfsPath: string,
  guestPath: string,
): Promise<{ exists: boolean; size: number }> {
  try {
    const { stdout } = await execFileAsync("debugfs", ["-R", `stat ${guestPath}`, rootfsPath], {
      timeout: 5_000,
    });
    const sizeMatch = stdout.match(/Size:\s+(\d+)/);
    return {
      exists: true,
      size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
    };
  } catch (err) {
    const message = String(err);
    if (!warnedMissingDebugfs && /debugfs/.test(message) && /ENOENT|not found/i.test(message)) {
      warnedMissingDebugfs = true;
      logger.warn("debugfs not available; skipping rootfs vsock binary validation", {
        rootfsPath,
      });
      rootfsVsockInitCache.set(rootfsPath, DEFAULT_VSOCK_INIT_PATH);
      return { exists: true, size: MIN_VSOCK_AGENT_BYTES };
    }
    return { exists: false, size: 0 };
  }
}

async function checkRootfsReadableByJailer(
  rootfsPath: string,
  jailerUid: string,
  jailerGid: string,
): Promise<RootfsReadabilityCheck> {
  if (!/^\d+$/.test(jailerUid) || !/^\d+$/.test(jailerGid)) {
    return {
      readable: false,
      reason: "invalid_jailer_identity",
      path: rootfsPath,
      resolvedPath: rootfsPath,
      jailerUid,
      jailerGid,
      error: "jailer uid/gid must be numeric",
    };
  }

  const uid = parseInt(jailerUid, 10);
  const gid = parseInt(jailerGid, 10);

  try {
    const { stdout: resolvedStdout } = await execFileAsync("readlink", ["-f", rootfsPath]);
    const resolvedPath = resolvedStdout.trim() || rootfsPath;
    const { stat } = await import("node:fs/promises");
    const fsStat = await stat(resolvedPath);
    const modeBits = fsStat.mode & 0o777;
    const mode = modeBits.toString(8).padStart(3, "0");

    const readable =
      uid === 0 ||
      (uid === fsStat.uid && (modeBits & 0o400) !== 0) ||
      (gid === fsStat.gid && (modeBits & 0o040) !== 0) ||
      (modeBits & 0o004) !== 0;

    return {
      readable,
      reason: readable ? "ok" : "permission_denied",
      path: rootfsPath,
      resolvedPath,
      jailerUid,
      jailerGid,
      mode,
      ownerUid: fsStat.uid,
      ownerGid: fsStat.gid,
    };
  } catch (err) {
    return {
      readable: false,
      reason: "stat_failed",
      path: rootfsPath,
      resolvedPath: rootfsPath,
      jailerUid,
      jailerGid,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function tailForLog(input: string, maxChars = 1200): string {
  const compact = input.replace(/\s+/g, " ").replace(/,/g, ";").trim();
  if (!compact) return "";
  return compact.length <= maxChars ? compact : compact.slice(-maxChars);
}

async function waitForProcessExitBriefly(
  processRef: Promise<FirecrackerProcessExit>,
  timeoutMs: number,
): Promise<FirecrackerProcessExit | null> {
  return Promise.race([
    processRef.then((result) => result),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

async function terminateFirecrackerProcess(
  firecrackerPid: number,
  processRef?: Promise<FirecrackerProcessExit>,
): Promise<void> {
  const alreadyExited = processRef ? await waitForProcessExitBriefly(processRef, 0) : null;
  if (alreadyExited) return;

  try {
    process.kill(firecrackerPid, "SIGTERM");
  } catch {
    return;
  }

  if (processRef) {
    const exitedAfterTerm = await waitForProcessExitBriefly(processRef, 500);
    if (exitedAfterTerm) return;
  } else {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  try {
    process.kill(firecrackerPid, "SIGKILL");
  } catch {
    // already gone
  }
}

function buildVmBootError(params: {
  vmId: string;
  vmBootStage: "rootfs_access_check" | "jailer_launch" | "vsock_wait";
  rootfsAccessCheck: RootfsReadabilityCheck["reason"] | string;
  processExit?: FirecrackerProcessExit;
  cause?: unknown;
  stdoutTail?: string;
  stderrTail?: string;
}): Error {
  const { vmId, vmBootStage, rootfsAccessCheck, processExit, cause, stdoutTail, stderrTail } = params;
  const firecrackerExitCode =
    processExit?.exitCode !== undefined && processExit?.exitCode !== null
      ? String(processExit.exitCode)
      : processExit
        ? "unknown"
        : "not_exited";
  const firecrackerStdoutTail = tailForLog(processExit?.stdout ?? stdoutTail ?? "");
  const firecrackerStderrTailRaw = tailForLog(processExit?.stderr ?? stderrTail ?? "");
  const firecrackerDiagnosticTail = firecrackerStderrTailRaw || firecrackerStdoutTail;
  const signal = processExit?.signal ? String(processExit.signal) : undefined;
  const processError = processExit?.processError ? tailForLog(processExit.processError) : undefined;
  const causeMessage =
    cause instanceof Error ? tailForLog(cause.message) : cause ? tailForLog(String(cause)) : undefined;

  const details = [
    `vmBootStage=${vmBootStage}`,
    `rootfsAccessCheck=${rootfsAccessCheck}`,
    `firecrackerExitCode=${firecrackerExitCode}`,
    signal ? `firecrackerSignal=${signal}` : null,
    firecrackerDiagnosticTail ? `firecrackerStderrTail=${firecrackerDiagnosticTail}` : null,
    firecrackerStderrTailRaw && firecrackerStdoutTail
      ? `firecrackerStdoutTail=${firecrackerStdoutTail}`
      : null,
    processError ? `firecrackerProcessError=${processError}` : null,
    causeMessage ? `lastError=${causeMessage}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return new Error(`VM boot failed for ${vmId} (${details})`);
}

/**
 * SECURITY (P2-1): Apply iptables FORWARD rules on TAP device.
 * Only allows DNS (53) + HTTPS (443) egress; drops all else.
 */
async function applyEgressFiltering(tapDevice: string): Promise<void> {
  // SECURITY (M4): Only allow DNS (53) and HTTPS (443) egress.
  // TCP 80 (HTTP) is dropped to prevent MitM on package downloads.
  // All package managers and git support HTTPS.
  const rules: string[][] = [
    // Allow return traffic from allowed outbound flows back into the VM.
    ["FORWARD", "-o", tapDevice, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
    // Allow DNS (UDP 53)
    ["FORWARD", "-i", tapDevice, "-p", "udp", "--dport", "53", "-j", "ACCEPT"],
    // Allow HTTPS (TCP 443)
    ["FORWARD", "-i", tapDevice, "-p", "tcp", "--dport", "443", "-j", "ACCEPT"],
    // Drop everything else from this TAP
    ["FORWARD", "-i", tapDevice, "-j", "DROP"],
  ];

  for (const rule of rules) {
    await execFileAsync("iptables", ["-A", ...rule]).catch((err) => {
      logger.warn("Failed to add iptables rule", { rule: rule.join(" "), error: String(err) });
    });
  }
}

/**
 * Remove iptables rules for a TAP device during teardown.
 */
async function removeEgressFiltering(tapDevice: string): Promise<void> {
  // Remove all FORWARD rules referencing this TAP device.
  // Run multiple times since there are multiple rules.
  for (let i = 0; i < 5; i++) {
    await execFileAsync("iptables", ["-D", "FORWARD", "-o", tapDevice, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"]).catch(() => {});
    await execFileAsync("iptables", ["-D", "FORWARD", "-i", tapDevice, "-p", "udp", "--dport", "53", "-j", "ACCEPT"]).catch(() => {});
    await execFileAsync("iptables", ["-D", "FORWARD", "-i", tapDevice, "-p", "tcp", "--dport", "443", "-j", "ACCEPT"]).catch(() => {});
    await execFileAsync("iptables", ["-D", "FORWARD", "-i", tapDevice, "-j", "DROP"]).catch(() => {});
  }
}

/**
 * Execute a command inside the guest over SSH.
 * Uses per-VM SSH key when provided, falls back to global key.
 */
async function execInVM(
  guestIp: string,
  command: string,
  timeoutMs: number,
  sshKeyPath: string = SSH_KEY_PATH,
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "ssh",
      [
        "-i",
        sshKeyPath,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        `ConnectTimeout=${Math.ceil(timeoutMs / 1_000)}`,
        "-p",
        String(GUEST_SSH_PORT),
        `root@${guestIp}`,
        command,
      ],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
    );

    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execErr.stdout ?? "",
      stderr: execErr.stderr ?? String(err),
      exitCode: execErr.code ?? 1,
    };
  }
}

/**
 * Poll until SSH is available inside the guest, with exponential back-off.
 */
async function waitForSSH(
  guestIp: string,
  vmId: string,
  sshKeyPath: string = SSH_KEY_PATH,
  maxRetries: number = 30,
  baseDelayMs: number = 500,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await execFileAsync(
        "ssh",
        [
          "-i",
          sshKeyPath,
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-o",
          "ConnectTimeout=2",
          "-p",
          String(GUEST_SSH_PORT),
          `root@${guestIp}`,
          "echo ok",
        ],
        { timeout: 5_000 },
      );
      return;
    } catch {
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 5_000);
      logger.debug("SSH not yet available", { vmId, attempt, nextRetryMs: delay });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`SSH not reachable for VM ${vmId} after ${maxRetries} retries`);
}

interface VmNetworkAllocation {
  guestIp: string;
  gatewayIp: string;
}

/**
 * Track allocated guest IPs and /30 subnets to prevent collisions.
 */
const allocatedIps = new Set<string>();
const allocatedSubnetIndexes = new Set<number>();
const guestIpToSubnetIndex = new Map<string, number>();
const MAX_VM_SUBNETS = 63; // 10.0.0.0/24 split into 63 usable /30 subnets (excludes .252/30)

/**
 * Allocate a unique /30 subnet per VM:
 *   subnet base = N * 4
 *   gateway     = base + 1
 *   guest       = base + 2
 */
function allocateVmNetwork(vmId: string): VmNetworkAllocation {
  let hash = 0;
  for (const ch of vmId) {
    hash = (hash * 31 + ch.charCodeAt(0)) & 0xffffffff;
  }

  const preferredIndex = Math.abs(hash) % MAX_VM_SUBNETS;
  for (let i = 0; i < MAX_VM_SUBNETS; i++) {
    const subnetIndex = (preferredIndex + i) % MAX_VM_SUBNETS;
    if (allocatedSubnetIndexes.has(subnetIndex)) continue;

    const baseOctet = subnetIndex * 4;
    const gatewayIp = `10.0.0.${baseOctet + 1}`;
    const guestIp = `10.0.0.${baseOctet + 2}`;

    allocatedSubnetIndexes.add(subnetIndex);
    allocatedIps.add(guestIp);
    guestIpToSubnetIndex.set(guestIp, subnetIndex);

    return { guestIp, gatewayIp };
  }

  throw new Error(`No available VM /30 subnets — all ${MAX_VM_SUBNETS} subnets in use`);
}

/**
 * Release a guest IP back to the pool when a VM is destroyed.
 */
export function releaseGuestIp(ip: string): void {
  allocatedIps.delete(ip);
  const subnetIndex = guestIpToSubnetIndex.get(ip);
  if (subnetIndex !== undefined) {
    guestIpToSubnetIndex.delete(ip);
    allocatedSubnetIndexes.delete(subnetIndex);
  }
}

/** Exported for testing. */
export function _getAllocatedIps(): Set<string> {
  return allocatedIps;
}

/** Exported for testing. */
export function _resetIpAllocationsForTests(): void {
  allocatedIps.clear();
  allocatedSubnetIndexes.clear();
  guestIpToSubnetIndex.clear();
}

/**
 * Build the Firecracker JSON configuration object.
 */
function buildVMConfig(opts: {
  vmId: string;
  kernelImage: string;
  rootfsPath: string;
  vcpuCount: number;
  memSizeMib: number;
  tapDevice: string;
  guestIp: string;
  gatewayIp: string;
  vsockSocketPath?: string;
  vsockInitPath?: string;
}): Record<string, unknown> {
  const bootArgs: string[] = [
    "console=ttyS0",
    "reboot=k",
    "panic=1",
    "pci=off",
    `ip=${opts.guestIp}::${opts.gatewayIp}:255.255.255.252::eth0:off`,
  ];
  if (opts.vsockSocketPath && opts.vsockInitPath) {
    bootArgs.push(`init=${opts.vsockInitPath}`);
  }

  const config: Record<string, unknown> = {
    "boot-source": {
      kernel_image_path: opts.kernelImage,
      boot_args: bootArgs.join(" "),
    },
    "drives": [
      {
        drive_id: "rootfs",
        path_on_host: opts.rootfsPath,
        is_root_device: true,
        is_read_only: false,
      },
    ],
    "machine-config": {
      vcpu_count: opts.vcpuCount,
      mem_size_mib: opts.memSizeMib,
    },
    "network-interfaces": [
      {
        iface_id: "eth0",
        guest_mac: generateMac(opts.vmId),
        host_dev_name: opts.tapDevice,
      },
    ],
  };

  // Add vsock device for host ↔ guest communication
  if (opts.vsockSocketPath) {
    config["vsock"] = {
      guest_cid: 3,
      uds_path: opts.vsockSocketPath,
    };
  }

  return config;
}

/**
 * Generate a deterministic MAC address from the VM ID.
 */
function generateMac(vmId: string): string {
  let hash = 0;
  for (const ch of vmId) {
    hash = (hash * 37 + ch.charCodeAt(0)) & 0xffffffff;
  }
  const bytes = [
    0x02, // locally administered, unicast
    (hash >> 24) & 0xff,
    (hash >> 16) & 0xff,
    (hash >> 8) & 0xff,
    hash & 0xff,
    ((hash >> 4) ^ 0xa5) & 0xff,
  ];
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(":");
}
