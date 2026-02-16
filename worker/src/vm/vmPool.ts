/**
 * Warm VM pool for fast workspace provisioning.
 *
 * Maintains a pool of pre-booted Firecracker VMs per language.
 * When a workspace is requested, a warm VM is popped from the pool
 * instead of booting fresh, saving 2-15s of VM boot time.
 *
 * Warm VMs count against a separate MAX_WARM_VMS limit (not MAX_DEV_VMS)
 * to prevent warm VMs from stealing capacity from active workspaces.
 */

import { logger } from "../index";
import { createFirecrackerVM, destroyFirecrackerVM, VMHandle } from "./firecracker";
import { getVMConfig } from "./vmConfig";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WarmVM {
  vmHandle: VMHandle;
  language: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_POOL_SIZE = parseInt(process.env.WARM_POOL_SIZE ?? "2", 10);
const MAX_WARM_VMS = parseInt(process.env.MAX_WARM_VMS ?? "4", 10);
const MAX_WARM_AGE_MS = 10 * 60 * 1000; // 10 min — recycle stale warm VMs

/** Languages to pre-warm on startup. */
const DEFAULT_WARM_LANGUAGES = ["typescript", "python"];

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

class VMPool {
  private pool = new Map<string, WarmVM[]>(); // language → warm VMs
  private replenishing = new Set<string>(); // languages currently being replenished
  private recycleTimer: NodeJS.Timeout | null = null;

  /**
   * Initialize the warm pool by pre-booting VMs for common languages.
   * Boot happens in background — does not block worker startup.
   */
  async initialize(): Promise<void> {
    logger.info("Initializing warm VM pool", {
      targetSize: TARGET_POOL_SIZE,
      maxWarm: MAX_WARM_VMS,
      languages: DEFAULT_WARM_LANGUAGES,
    });

    // Pre-warm in background
    for (const lang of DEFAULT_WARM_LANGUAGES) {
      for (let i = 0; i < TARGET_POOL_SIZE; i++) {
        this.replenish(lang).catch((err) => {
          logger.warn("Failed to pre-warm VM", { language: lang, error: String(err) });
        });
      }
    }

    // Start recycler for stale warm VMs
    this.recycleTimer = setInterval(() => this.recycleStale(), 60_000);
  }

  /**
   * Acquire a warm VM for the given language.
   * Returns null if no warm VM is available (caller boots fresh).
   * Triggers background replenishment after acquisition.
   */
  async acquire(language: string): Promise<VMHandle | null> {
    const vms = this.pool.get(language);
    if (!vms || vms.length === 0) return null;

    const warm = vms.pop()!;

    // Check if too old
    if (Date.now() - warm.createdAt > MAX_WARM_AGE_MS) {
      // Stale — destroy and return null
      destroyFirecrackerVM(warm.vmHandle).catch(() => {});
      // Trigger replenish
      this.replenish(language).catch(() => {});
      return null;
    }

    logger.info("Acquired warm VM", {
      language,
      vmId: warm.vmHandle.vmId,
      warmAgeMs: Date.now() - warm.createdAt,
      remainingPool: vms.length,
    });

    // Replenish in background
    this.replenish(language).catch(() => {});

    return warm.vmHandle;
  }

  /**
   * Boot a new VM and add it to the pool (background, non-blocking).
   */
  private async replenish(language: string): Promise<void> {
    // Don't double-replenish
    const key = language;
    if (this.replenishing.has(key)) return;

    // Check total warm count
    const totalWarm = this.totalCount();
    if (totalWarm >= MAX_WARM_VMS) return;

    // Check per-language count
    const langVMs = this.pool.get(language) ?? [];
    if (langVMs.length >= TARGET_POOL_SIZE) return;

    this.replenishing.add(key);

    try {
      const config = getVMConfig(language);
      // Use dev-class resources (more CPU/RAM for interactive work)
      const vmConfig = {
        vcpuCount: Math.max(config.vcpuCount, 2),
        memSizeMib: Math.max(config.memSizeMib, 2048),
        rootfsImage: config.rootfsImage,
      };

      const jobId = `warm-${language}-${Date.now()}`;
      const vm = await createFirecrackerVM({
        jobId,
        rootfsImage: vmConfig.rootfsImage,
        vcpuCount: vmConfig.vcpuCount,
        memSizeMib: vmConfig.memSizeMib,
      });

      let vms = this.pool.get(language);
      if (!vms) {
        vms = [];
        this.pool.set(language, vms);
      }

      // Double-check we haven't exceeded limits while awaiting
      if (vms.length >= TARGET_POOL_SIZE || this.totalCount() >= MAX_WARM_VMS) {
        await destroyFirecrackerVM(vm);
        return;
      }

      vms.push({
        vmHandle: vm,
        language,
        createdAt: Date.now(),
      });

      logger.debug("Replenished warm VM", { language, vmId: vm.vmId, poolSize: vms.length });
    } catch (err) {
      logger.warn("Failed to replenish warm VM", {
        language,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.replenishing.delete(key);
    }
  }

  /**
   * Recycle warm VMs that are older than MAX_WARM_AGE_MS.
   */
  private recycleStale(): void {
    const now = Date.now();
    for (const [language, vms] of this.pool) {
      const stale = vms.filter((v) => now - v.createdAt > MAX_WARM_AGE_MS);
      for (const vm of stale) {
        const idx = vms.indexOf(vm);
        if (idx >= 0) vms.splice(idx, 1);
        destroyFirecrackerVM(vm.vmHandle).catch(() => {});
        logger.debug("Recycled stale warm VM", { language, vmId: vm.vmHandle.vmId });
      }
      // Replenish after recycling
      if (vms.length < TARGET_POOL_SIZE) {
        this.replenish(language).catch(() => {});
      }
    }
  }

  /**
   * Total number of warm VMs across all languages.
   */
  totalCount(): number {
    let count = 0;
    for (const vms of this.pool.values()) {
      count += vms.length;
    }
    return count;
  }

  /**
   * Count of warm VMs for a specific language.
   */
  countForLanguage(language: string): number {
    return this.pool.get(language)?.length ?? 0;
  }

  /**
   * Destroy all warm VMs (called on shutdown).
   */
  async drainAll(): Promise<void> {
    if (this.recycleTimer) {
      clearInterval(this.recycleTimer);
      this.recycleTimer = null;
    }

    const promises: Promise<void>[] = [];
    for (const [, vms] of this.pool) {
      for (const vm of vms) {
        promises.push(
          destroyFirecrackerVM(vm.vmHandle).catch(() => {}),
        );
      }
    }
    this.pool.clear();
    await Promise.allSettled(promises);
    logger.info("Warm VM pool drained");
  }
}

/** Singleton pool instance. */
export const vmPool = new VMPool();
