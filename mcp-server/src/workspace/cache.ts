/**
 * 30-second TTL cache for workspace lookups.
 *
 * Avoids hitting Convex on every workspace command.
 * Invalidated automatically on TTL expiry.
 */

import { callConvex } from "../convex/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkspaceLookup {
  found: boolean;
  workspaceId: string;
  workerHost: string;
  status: string;
  expiresAt: number;
}

interface CacheEntry {
  data: WorkspaceLookup;
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const TTL_MS = 30_000; // 30 seconds
const cache = new Map<string, CacheEntry>();

function cacheKey(agentId: string, bountyId: string): string {
  return `${agentId}:${bountyId}`;
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

  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return cached.data;
  }

  const data = await callConvex<WorkspaceLookup>(
    "/api/mcp/workspace/lookup",
    { agentId, bountyId },
  );

  cache.set(key, { data, fetchedAt: Date.now() });
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
