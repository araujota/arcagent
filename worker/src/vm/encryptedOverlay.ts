/**
 * Encrypted workspace overlay using dm-crypt plain mode.
 *
 * Each microVM gets an ephemeral 256-bit AES key. The overlay is encrypted
 * with dm-crypt plain mode (no LUKS header = zero on-disk metadata). The key
 * is held only in kernel memory and zeroed on teardown.
 *
 * This prevents host-level attacks from reading repo code via
 * `mount -o loop /tmp/fc-overlay-*.ext4 /mnt`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { logger } from "../index";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Handle for an encrypted overlay, needed for teardown. */
export interface EncryptedOverlayHandle {
  /** The loop device (e.g. /dev/loop0). */
  loopDevice: string;
  /** The dm-crypt device name (e.g. fc-crypt-vm-abc12345). */
  cryptName: string;
  /** The dm-crypt device path (e.g. /dev/mapper/fc-crypt-vm-abc12345). */
  devicePath: string;
  /** The backing file path. */
  backingFile: string;
  /** The ephemeral key buffer (zeroed on teardown). */
  keyBuffer: Buffer;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an encrypted overlay from a rootfs source image.
 *
 * 1. Generate 256-bit random key
 * 2. Create a sparse backing file
 * 3. Set up loop device
 * 4. Open dm-crypt plain mode
 * 5. Copy rootfs onto the encrypted device
 *
 * @param vmId - Unique VM identifier for naming
 * @param sourcePath - Path to the source rootfs ext4 image
 * @returns Handle for the encrypted overlay (pass to destroyEncryptedOverlay)
 */
export async function createEncryptedOverlay(
  vmId: string,
  sourcePath: string,
): Promise<EncryptedOverlayHandle> {
  const cryptName = `fc-crypt-${vmId}`;
  const backingFile = `/tmp/fc-overlay-${vmId}.ext4`;
  const keyBuffer = randomBytes(32);

  logger.info("Creating encrypted overlay", { vmId, cryptName });

  // 1. Copy rootfs to backing file
  await execFileAsync("cp", ["--reflink=auto", sourcePath, backingFile]);

  // 2. Create loop device
  const { stdout: loopStdout } = await execFileAsync("losetup", [
    "--find",
    "--show",
    backingFile,
  ]);
  const loopDevice = loopStdout.trim();

  try {
    // 3. Open dm-crypt plain mode (key via stdin, no LUKS header)
    await new Promise<void>((resolve, reject) => {
      const proc = execFile(
        "cryptsetup",
        [
          "open",
          "--type", "plain",
          "--key-file=-",
          "--cipher", "aes-xts-plain64",
          "--key-size", "256",
          loopDevice,
          cryptName,
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
      // Pipe key as raw bytes via stdin
      proc.stdin!.write(keyBuffer);
      proc.stdin!.end();
    });

    const devicePath = `/dev/mapper/${cryptName}`;

    // 4. Copy the rootfs content onto the encrypted device
    await execFileAsync("dd", [
      `if=${sourcePath}`,
      `of=${devicePath}`,
      "bs=4M",
      "conv=notrunc",
    ], { timeout: 60_000 });

    logger.info("Encrypted overlay created", { vmId, loopDevice, devicePath });

    return {
      loopDevice,
      cryptName,
      devicePath,
      backingFile,
      keyBuffer,
    };
  } catch (err) {
    // Cleanup on failure — close dm-crypt if it was opened, then loop, then file
    await execFileAsync("cryptsetup", ["close", cryptName]).catch(() => {});
    await execFileAsync("losetup", ["-d", loopDevice]).catch(() => {});
    await unlink(backingFile).catch(() => {});
    keyBuffer.fill(0);
    throw err;
  }
}

/**
 * Destroy an encrypted overlay and wipe all traces.
 *
 * 1. Close dm-crypt (wipes key from kernel memory)
 * 2. Detach loop device
 * 3. Delete backing file (now random garbage)
 * 4. Zero the key buffer in Node.js memory
 */
export async function destroyEncryptedOverlay(
  handle: EncryptedOverlayHandle,
): Promise<void> {
  logger.info("Destroying encrypted overlay", { cryptName: handle.cryptName });

  // 1. Close dm-crypt
  await execFileAsync("cryptsetup", ["close", handle.cryptName]).catch((err) => {
    logger.warn("Failed to close dm-crypt", {
      cryptName: handle.cryptName,
      error: String(err),
    });
  });

  // 2. Detach loop device
  await execFileAsync("losetup", ["-d", handle.loopDevice]).catch((err) => {
    logger.warn("Failed to detach loop device", {
      loopDevice: handle.loopDevice,
      error: String(err),
    });
  });

  // 3. Delete backing file
  await unlink(handle.backingFile).catch(() => {});

  // 4. Zero key in Node.js memory
  handle.keyBuffer.fill(0);

  logger.info("Encrypted overlay destroyed", { cryptName: handle.cryptName });
}

// ---------------------------------------------------------------------------
// Startup cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up stale dm-crypt devices from previous worker runs.
 * Called once at startup to handle unclean shutdowns.
 */
export async function cleanupStaleCryptDevices(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("dmsetup", ["ls", "--target", "crypt"]);
    const lines = stdout.trim().split("\n").filter((l) => l.startsWith("fc-crypt-"));

    for (const line of lines) {
      const name = line.split(/\s+/)[0];
      if (!name) continue;

      logger.warn("Cleaning up stale dm-crypt device", { name });
      await execFileAsync("cryptsetup", ["close", name]).catch(() => {});
    }

    if (lines.length > 0) {
      logger.info(`Cleaned up ${lines.length} stale dm-crypt device(s)`);
    }
  } catch {
    // dmsetup may not exist or no stale devices — that's fine
  }
}
