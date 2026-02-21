import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../index";
import { vsockExec, vsockExecWithStdin, vsockWriteFile, waitForVsock, sendVsockRequestPooled, VsockRequest, VsockResponse, vsockPool } from "./vsockChannel";
import { createEncryptedOverlay, destroyEncryptedOverlay, EncryptedOverlayHandle } from "./encryptedOverlay";
import { startDnsResolver, stopDnsResolver, applyDnsRedirect, removeDnsRedirect, DnsResolverHandle } from "./dnsPolicy";
import { startEgressProxy, stopEgressProxy, applyProxyRedirect, removeProxyRedirect, applyRateLimiting, removeRateLimiting, EgressProxyHandle } from "./egressProxy";
import { getVMConfig } from "./vmConfig";

const execFileAsync = promisify(execFile);

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
/** SSH key path for SSH fallback (when vsock is disabled). */
const SSH_KEY_PATH = process.env.FC_SSH_KEY_PATH ?? "/root/.ssh/id_ed25519";
/** SSH port on guest (when vsock is disabled). */
const GUEST_SSH_PORT = parseInt(process.env.FC_GUEST_SSH_PORT ?? "22", 10);

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
  const vmId = `vm-${uuidv4().slice(0, 8)}`;
  const tapDevice = `${TAP_PREFIX}${vmId.slice(3)}`;
  const guestIp = allocateGuestIp(vmId);
  const vsockSocketPath = `/tmp/fc-vsock-${vmId}.sock`;

  logger.info("Creating Firecracker microVM", {
    vmId,
    jobId: opts.jobId,
    vcpuCount: opts.vcpuCount,
    memSizeMib: opts.memSizeMib,
    rootfsImage: opts.rootfsImage,
    useVsock: USE_VSOCK,
  });

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

  await execFileAsync("ip", ["addr", "add", `${guestIp}/30`, "dev", tapDevice]);
  await execFileAsync("ip", ["link", "set", tapDevice, "up"]);

  // SECURITY (P2-1): Apply iptables egress filtering on the TAP device.
  await applyEgressFiltering(tapDevice);

  // Hardened egress: DNS resolver + SNI proxy + rate limiting (if enabled)
  let dnsResolver: DnsResolverHandle | null = null;
  let egressProxy: EgressProxyHandle | null = null;
  const vmConfig = getVMConfig(opts.rootfsImage.replace(/\.ext4$/, "").replace(/-\d+$/, ""));
  const hardenEgress = process.env.FC_HARDEN_EGRESS !== "false"
    && (process.env.FC_HARDEN_EGRESS === "true" || process.env.NODE_ENV === "production");

  if (hardenEgress && vmConfig.allowedDomains.length > 0) {
    const gatewayIp = "10.0.0.1";
    try {
      dnsResolver = await startDnsResolver(vmId, gatewayIp, vmConfig.allowedDomains);
      await applyDnsRedirect(tapDevice, gatewayIp);
      egressProxy = await startEgressProxy(vmId, vmConfig.allowedDomains);
      await applyProxyRedirect(tapDevice, egressProxy.port);
      await applyRateLimiting(tapDevice);
      logger.info("Hardened egress applied", { vmId, domains: vmConfig.allowedDomains.length });
    } catch (err) {
      logger.warn("Hardened egress setup failed, using basic filtering", {
        vmId,
        error: String(err),
      });
    }
  }

  // 2. Prepare ephemeral overlay of rootfs (with encryption if available)
  const rootfsPath = `${ROOTFS_DIR}/${opts.rootfsImage}`;
  let overlayPath: string;
  let encryptedOverlay: EncryptedOverlayHandle | null = null;

  if (USE_VSOCK) {
    // Use encrypted overlay — protects repo code from host-level access
    try {
      encryptedOverlay = await createEncryptedOverlay(vmId, rootfsPath);
      overlayPath = encryptedOverlay.devicePath;
      logger.info("Using encrypted overlay", { vmId });
    } catch (err) {
      // Fallback to unencrypted if dm-crypt unavailable (dev environments)
      logger.warn("Encrypted overlay failed, falling back to unencrypted", {
        vmId,
        error: String(err),
      });
      overlayPath = `/tmp/fc-overlay-${vmId}.ext4`;
      await execFileAsync("cp", ["--reflink=auto", rootfsPath, overlayPath]);
    }
  } else {
    overlayPath = `/tmp/fc-overlay-${vmId}.ext4`;
    await execFileAsync("cp", ["--reflink=auto", rootfsPath, overlayPath]);
  }

  // 2a. Generate per-VM SSH keypair (only if not using vsock)
  let vmSshKeyPath: string | undefined;
  if (!USE_VSOCK) {
    vmSshKeyPath = `/tmp/fc-ssh-${vmId}`;
    await execFileAsync("ssh-keygen", [
      "-t", "ed25519", "-f", vmSshKeyPath, "-N", "", "-q",
    ]);
  }

  // 3. Build Firecracker config (with vsock device if enabled)
  const config = buildVMConfig({
    vmId,
    kernelImage: KERNEL_IMAGE,
    rootfsPath: overlayPath,
    vcpuCount: opts.vcpuCount,
    memSizeMib: opts.memSizeMib,
    tapDevice,
    guestIp,
    vsockSocketPath: USE_VSOCK ? vsockSocketPath : undefined,
  });

  const configPath = `/tmp/fc-config-${vmId}.json`;
  const { writeFile, chmod } = await import("node:fs/promises");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  // Set vsock socket permissions (worker process only)
  if (USE_VSOCK) {
    // Socket will be created by Firecracker, set parent dir permissions
    // The socket itself will have restrictive permissions
  }

  // 4. Launch Firecracker via jailer (raw execFile to capture PID)
  const fcChild = execFile(JAILER_BIN, [
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
  ]);
  const firecrackerPid = fcChild.pid;

  const vmProcessRef = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "", stderr = "";
    fcChild.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    fcChild.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    fcChild.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`Firecracker exited ${code}: ${stderr}`)));
    fcChild.on("error", reject);
  });
  // Prevent unhandledRejection if Firecracker crashes — we handle the error
  // via destroyFirecrackerVM or process monitoring, not via this promise.
  vmProcessRef.catch(() => {});

  // 5. Wait for communication channel
  if (USE_VSOCK) {
    await waitForVsock(vsockSocketPath, vmId);
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
    // Release the allocated IP to prevent leaks on partial VM creation failure
    releaseGuestIp(guestIp);
    throw err;
  }
}

/**
 * Tear down a Firecracker microVM and clean up all resources.
 * SECURITY (P2-4): Hardened teardown — kill by PID, verify cleanup, log warnings.
 */
export async function destroyFirecrackerVM(handle: VMHandle): Promise<void> {
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
  __processRef?: Promise<{ stdout: string; stderr: string }>;
  __firecrackerPid?: number;
  __vsockSocketPath?: string;
  __encryptedOverlay?: EncryptedOverlayHandle;
  __dnsResolver?: DnsResolverHandle;
  __egressProxy?: EgressProxyHandle;
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
    // Allow established/related connections back in
    ["FORWARD", "-i", tapDevice, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
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
    await execFileAsync("iptables", ["-D", "FORWARD", "-i", tapDevice, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"]).catch(() => {});
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

/**
 * Track allocated guest IPs to prevent collisions across concurrent VMs.
 */
const allocatedIps = new Set<string>();

/**
 * Allocate a guest IP for a VM, ensuring no collision with running VMs.
 * Falls back to linear scan if hash-preferred IP is taken.
 */
function allocateGuestIp(vmId: string): string {
  let hash = 0;
  for (const ch of vmId) {
    hash = (hash * 31 + ch.charCodeAt(0)) & 0xffffffff;
  }
  // Try hash-preferred octet first
  const preferred = (Math.abs(hash) % 252) + 2;
  const preferredIp = `10.0.0.${preferred}`;
  if (!allocatedIps.has(preferredIp)) {
    allocatedIps.add(preferredIp);
    return preferredIp;
  }
  // Linear scan for next available
  for (let i = 0; i < 252; i++) {
    const octet = ((preferred - 2 + i) % 252) + 2;
    const ip = `10.0.0.${octet}`;
    if (!allocatedIps.has(ip)) {
      allocatedIps.add(ip);
      return ip;
    }
  }
  throw new Error("No available guest IPs — all 252 addresses in use");
}

/**
 * Release a guest IP back to the pool when a VM is destroyed.
 */
export function releaseGuestIp(ip: string): void {
  allocatedIps.delete(ip);
}

/** Exported for testing. */
export function _getAllocatedIps(): Set<string> {
  return allocatedIps;
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
  vsockSocketPath?: string;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {
    "boot-source": {
      kernel_image_path: opts.kernelImage,
      boot_args:
        "console=ttyS0 reboot=k panic=1 pci=off " +
        `ip=${opts.guestIp}::10.0.0.1:255.255.255.252::eth0:off`,
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
