import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../index";

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
  /** Execute a shell command inside the guest via SSH. */
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;
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
const SSH_KEY_PATH =
  process.env.FC_SSH_KEY ?? "/var/lib/firecracker/id_rsa";
const TAP_PREFIX = "fc-tap-";
const GUEST_SSH_PORT = 22;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000; // 2 minutes

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

  logger.info("Creating Firecracker microVM", {
    vmId,
    jobId: opts.jobId,
    vcpuCount: opts.vcpuCount,
    memSizeMib: opts.memSizeMib,
    rootfsImage: opts.rootfsImage,
  });

  // 1. Create TAP device
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

  // 2. Prepare ephemeral overlay of rootfs
  const rootfsPath = `${ROOTFS_DIR}/${opts.rootfsImage}`;
  const overlayPath = `/tmp/fc-overlay-${vmId}.ext4`;

  await execFileAsync("cp", ["--reflink=auto", rootfsPath, overlayPath]);

  // 3. Build Firecracker config
  const config = buildVMConfig({
    vmId,
    kernelImage: KERNEL_IMAGE,
    rootfsPath: overlayPath,
    vcpuCount: opts.vcpuCount,
    memSizeMib: opts.memSizeMib,
    tapDevice,
    guestIp,
  });

  const configPath = `/tmp/fc-config-${vmId}.json`;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  // 4. Launch Firecracker via jailer
  const fcProcess = execFileAsync(JAILER_BIN, [
    "--id",
    vmId,
    "--exec-file",
    FIRECRACKER_BIN,
    "--uid",
    "1000",
    "--gid",
    "1000",
    "--",
    "--config-file",
    configPath,
    "--no-api",
  ]);

  // Store process reference for cleanup (fire-and-forget; the jailer manages the process)
  const vmProcessRef = fcProcess;

  // 5. Wait for SSH to become available
  await waitForSSH(guestIp, vmId);

  logger.info("MicroVM ready", { vmId, guestIp });

  // Build handle
  const handle: VMHandle = {
    vmId,
    jobId: opts.jobId,
    guestIp,

    async exec(
      command: string,
      timeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS,
    ): Promise<ExecResult> {
      return execInVM(guestIp, command, timeoutMs);
    },
  };

  // Stash cleanup metadata on the handle for destroyFirecrackerVM
  (handle as VMHandleInternal).__tapDevice = tapDevice;
  (handle as VMHandleInternal).__overlayPath = overlayPath;
  (handle as VMHandleInternal).__configPath = configPath;
  (handle as VMHandleInternal).__processRef = vmProcessRef;

  return handle;
}

/**
 * Tear down a Firecracker microVM and clean up all resources.
 */
export async function destroyFirecrackerVM(handle: VMHandle): Promise<void> {
  const internal = handle as VMHandleInternal;
  logger.info("Destroying microVM", { vmId: handle.vmId });

  // 1. Kill Firecracker process via jailer
  try {
    await execFileAsync("pkill", ["-f", `--id ${handle.vmId}`]);
  } catch {
    // Process may have already exited
  }

  // 2. Remove TAP device
  if (internal.__tapDevice) {
    await execFileAsync("ip", [
      "tuntap",
      "del",
      internal.__tapDevice,
      "mode",
      "tap",
    ]).catch(() => {});
  }

  // 3. Remove ephemeral files
  const { unlink } = await import("node:fs/promises");
  if (internal.__overlayPath) {
    await unlink(internal.__overlayPath).catch(() => {});
  }
  if (internal.__configPath) {
    await unlink(internal.__configPath).catch(() => {});
  }

  logger.info("MicroVM destroyed", { vmId: handle.vmId });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface VMHandleInternal extends VMHandle {
  __tapDevice?: string;
  __overlayPath?: string;
  __configPath?: string;
  __processRef?: Promise<{ stdout: string; stderr: string }>;
}

/**
 * Execute a command inside the guest over SSH.
 */
async function execInVM(
  guestIp: string,
  command: string,
  timeoutMs: number,
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "ssh",
      [
        "-i",
        SSH_KEY_PATH,
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
  maxRetries: number = 30,
  baseDelayMs: number = 500,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await execFileAsync(
        "ssh",
        [
          "-i",
          SSH_KEY_PATH,
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
 * Deterministically allocate a guest IP from the VM ID.
 * Uses a simple hash of the VM ID modulo a /24 subnet.
 */
function allocateGuestIp(vmId: string): string {
  let hash = 0;
  for (const ch of vmId) {
    hash = (hash * 31 + ch.charCodeAt(0)) & 0xffffffff;
  }
  // Use 10.0.0.0/24 subnet, skip .0 and .1 (network & host)
  const octet = (Math.abs(hash) % 252) + 2;
  return `10.0.0.${octet}`;
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
}): Record<string, unknown> {
  return {
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
