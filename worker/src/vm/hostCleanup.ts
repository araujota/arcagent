/**
 * Startup cleanup for orphaned host resources from prior hard crashes.
 *
 * Handles:
 * - Orphaned TAP devices (fc-tap-*)
 * - Orphaned iptables FORWARD rules referencing fc-tap-* devices
 * - Stale loop devices bound to fc-overlay-* files
 * - Orphaned /tmp/fc-* files (overlays, configs, sockets)
 *
 * NOTE: dm-crypt cleanup is handled separately by cleanupStaleCryptDevices()
 * in encryptedOverlay.ts.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, unlink } from "node:fs/promises";
import { logger } from "../index";

const execFileAsync = promisify(execFile);

/**
 * Clean up all orphaned host resources from prior unclean shutdowns.
 * Safe to call on every startup — idempotent.
 */
export async function cleanupStaleResources(): Promise<void> {
  await cleanupStaleTapDevices();
  await cleanupStaleIptablesRules();
  await cleanupStaleLoopDevices();
  await cleanupStaleTmpFiles();
}

/**
 * Remove orphaned TAP devices named fc-tap-*.
 */
async function cleanupStaleTapDevices(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("ip", ["-o", "link", "show"]);
    const tapDevices = stdout
      .split("\n")
      .map((line) => {
        const match = line.match(/:\s+(fc-tap-\S+?)[@:]/);
        return match ? match[1] : null;
      })
      .filter(Boolean) as string[];

    for (const tap of tapDevices) {
      logger.warn("Cleaning up orphaned TAP device", { tap });
      await execFileAsync("ip", ["tuntap", "del", tap, "mode", "tap"]).catch(
        () => {},
      );
    }

    if (tapDevices.length > 0) {
      logger.warn("Cleaned up orphaned TAP devices", { count: tapDevices.length });
    }
  } catch {
    // ip command may not exist or no orphaned TAPs — fine
  }
}

/**
 * Remove orphaned iptables FORWARD rules that reference fc-tap-* devices.
 */
async function cleanupStaleIptablesRules(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("iptables", ["-S", "FORWARD"]);
    const staleRules = stdout
      .split("\n")
      .filter((line) => line.includes("fc-tap-"));

    for (const rule of staleRules) {
      // Convert "-A FORWARD ..." to "-D FORWARD ..."
      const deleteRule = rule.replace(/^-A /, "-D ");
      const args = deleteRule.split(/\s+/).filter(Boolean);
      logger.warn("Cleaning up orphaned iptables rule", {
        rule: args.join(" "),
      });
      await execFileAsync("iptables", args).catch(() => {});
    }

    if (staleRules.length > 0) {
      logger.warn("Cleaned up orphaned iptables rules", { count: staleRules.length });
    }
  } catch {
    // iptables may not exist — fine
  }
}

/**
 * Detach orphaned loop devices that are bound to fc-overlay-* backing files.
 */
async function cleanupStaleLoopDevices(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("losetup", ["-l", "-n", "-O", "NAME,BACK-FILE"]);
    const lines = stdout.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const loopDev = parts[0];
      const backingFile = parts.slice(1).join(" ");
      if (loopDev && backingFile && backingFile.includes("fc-overlay-")) {
        logger.warn("Cleaning up orphaned loop device", {
          loopDev,
          backingFile,
        });
        await execFileAsync("losetup", ["-d", loopDev]).catch(() => {});
      }
    }
  } catch {
    // losetup may not exist or no orphaned loops — fine
  }
}

/**
 * Remove orphaned /tmp/fc-* files (overlays, configs, vsock sockets).
 */
async function cleanupStaleTmpFiles(): Promise<void> {
  try {
    const files = await readdir("/tmp");
    const staleFiles = files.filter(
      (f) =>
        f.startsWith("fc-overlay-") ||
        f.startsWith("fc-config-") ||
        f.startsWith("fc-vsock-") ||
        f.startsWith("fc-ssh-"),
    );

    for (const file of staleFiles) {
      logger.warn("Cleaning up orphaned tmp file", { file });
      await unlink(`/tmp/${file}`).catch(() => {});
    }

    if (staleFiles.length > 0) {
      logger.warn("Cleaned up orphaned tmp files", { count: staleFiles.length });
    }
  } catch {
    // /tmp read may fail — fine
  }
}
