/**
 * 120-second TTL cache for workspace lookups.
 *
 * Avoids hitting Convex on every workspace command.
 * Invalidated automatically on TTL expiry.
 */

import { callConvex } from "../convex/client";
import { LruTtlCache } from "../lib/lruCache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkspaceLookup =
  | {
      found: false;
      reason?: string;
      message?: string;
      claimId?: string;
      claimStatus?: string;
      expiresAt?: number;
    }
  | {
      found: true;
      workspaceId: string;
      workerHost: string;
      status: string;
      expiresAt: number;
      errorMessage?: string;
      claimId?: string;
    };

interface CacheEntry {
  data: WorkspaceLookup;
  fetchedAt: number;
  ttlMs: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const TTL_MS = 120_000; // 120 seconds default for non-ready states
const READY_TTL_MS = 20_000; // ready can go stale after worker restarts; refresh more often
const MAX_ENTRIES = 10_000;
const cache = new LruTtlCache<string, CacheEntry>(MAX_ENTRIES, TTL_MS);

function cacheKey(agentId: string, bountyId: string): string {
  return `${agentId}:${bountyId}`;
}

function cacheTtlForLookup(data: WorkspaceLookup): number {
  if (!data.found) return 0;
  if (data.status === "provisioning") return 5_000;
  if (data.status === "error") return 10_000;
  if (data.status === "destroyed") return 30_000;
  if (data.status === "ready") return READY_TTL_MS;
  return TTL_MS;
}

/**
 * Get workspace info for an agent + bounty pair.
 * Returns cached result if fresh, otherwise fetches from Convex.
 */
export async function getWorkspaceForAgent(
  agentId: string,
  bountyId: string,
): Promise<WorkspaceLookup> {
  const key = cacheKey(agentId, bountyId);
  const cached = cache.get(key);

  if (cached && Date.now() - cached.fetchedAt < cached.ttlMs) {
    return cached.data;
  }

  const data = await callConvex<WorkspaceLookup>(
    "/api/mcp/workspace/lookup",
    { agentId, bountyId },
  );

  const ttlMs = cacheTtlForLookup(data);
  if (ttlMs > 0) {
    cache.set(key, { data, fetchedAt: Date.now(), ttlMs });
  }
  return data;
}

/**
 * Invalidate cache for an agent + bounty pair.
 */
export function invalidateWorkspaceCache(
  agentId: string,
  bountyId: string,
): void {
  cache.delete(cacheKey(agentId, bountyId));
}

/**
 * Invalidate all cached entries for an agent.
 */
export function invalidateAllForAgent(agentId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${agentId}:`)) {
      cache.delete(key);
    }
  }
}

export function getWorkspaceCacheSize(): number {
  return cache.size();
}
