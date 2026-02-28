/**
 * Redis-backed session store for workspace sessions.
 *
 * Replaces the in-memory Map with a durable Redis store that survives
 * worker restarts and enables crash recovery across worker instances.
 *
 * Uses ioredis (already a dependency via BullMQ) and the same REDIS_URL.
 *
 * Key scheme:
 *   workspace:{workspaceId}            → Hash of SessionRecord fields
 *   workspace:by-agent:{agentId}       → Set of workspaceIds owned by agent
 *   worker:heartbeat:{instanceId}      → Timestamp string (TTL 30s)
 */

import Redis from "ioredis";
import { logger } from "../index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRecord {
  workspaceId: string;
  vmId: string;
  vsockSocketPath: string;
  tapDevice: string;
  overlayPath: string;
  /** Guest IP address allocated from the 10.0.0.x pool. */
  guestIp?: string;

  claimId: string;
  bountyId: string;
  agentId: string;
  language: string;
  baseRepoUrl: string;
  baseCommitSha: string;

  status: "provisioning" | "ready" | "error" | "destroyed";

  createdAt: number;
  readyAt?: number;
  expiresAt: number;
  lastActivityAt: number;
  lastHeartbeatAt: number;

  firecrackerPid: number;
  workerInstanceId: string;
  defaultSessionId?: string;

  /** Optional URL of the worker that owns this workspace session. */
  workerHost?: string;
}

export interface WorkspaceRouteRecord {
  workspaceId: string;
  workerHost: string;
  vmId?: string;
  guestIp?: string;
  status?: string;
  lastUpdatedAt: number;
}

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

const KEY_PREFIX = "workspace:";
const WORKSPACE_ROUTE_PREFIX = "workspace-route:";
const AGENT_INDEX_PREFIX = "workspace:by-agent:";
const WORKER_HEARTBEAT_PREFIX = "worker:heartbeat:";

function workspaceKey(workspaceId: string): string {
  return `${KEY_PREFIX}${workspaceId}`;
}

function agentIndexKey(agentId: string): string {
  return `${AGENT_INDEX_PREFIX}${agentId}`;
}

function workerHeartbeatKey(instanceId: string): string {
  return `${WORKER_HEARTBEAT_PREFIX}${instanceId}`;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Convert a SessionRecord to a flat string map suitable for Redis HSET.
 * Numbers become strings, undefined fields are omitted.
 */
function serializeRecord(record: SessionRecord): Record<string, string> {
  const flat: Record<string, string> = {
    workspaceId: record.workspaceId,
    vmId: record.vmId,
    vsockSocketPath: record.vsockSocketPath,
    tapDevice: record.tapDevice,
    overlayPath: record.overlayPath,
    claimId: record.claimId,
    bountyId: record.bountyId,
    agentId: record.agentId,
    language: record.language,
    baseRepoUrl: record.baseRepoUrl,
    baseCommitSha: record.baseCommitSha,
    status: record.status,
    createdAt: String(record.createdAt),
    expiresAt: String(record.expiresAt),
    lastActivityAt: String(record.lastActivityAt),
    lastHeartbeatAt: String(record.lastHeartbeatAt),
    firecrackerPid: String(record.firecrackerPid),
    workerInstanceId: record.workerInstanceId,
  };

  if (record.readyAt !== undefined) flat.readyAt = String(record.readyAt);
  if (record.defaultSessionId !== undefined) flat.defaultSessionId = record.defaultSessionId;
  if (record.guestIp !== undefined) flat.guestIp = record.guestIp;
  if (record.workerHost !== undefined) flat.workerHost = record.workerHost;

  return flat;
}

/**
 * Parse a flat Redis hash map back into a typed SessionRecord.
 * Returns null if the hash is empty or missing required fields.
 */
function deserializeRecord(
  hash: Record<string, string>,
): SessionRecord | null {
  if (!hash || !hash.workspaceId) return null;

  return {
    workspaceId: hash.workspaceId,
    vmId: hash.vmId,
    vsockSocketPath: hash.vsockSocketPath,
    tapDevice: hash.tapDevice,
    overlayPath: hash.overlayPath,
    claimId: hash.claimId,
    bountyId: hash.bountyId,
    agentId: hash.agentId,
    language: hash.language,
    baseRepoUrl: hash.baseRepoUrl,
    baseCommitSha: hash.baseCommitSha,
    status: hash.status as SessionRecord["status"],
    createdAt: parseInt(hash.createdAt, 10),
    readyAt: hash.readyAt ? parseInt(hash.readyAt, 10) : undefined,
    expiresAt: parseInt(hash.expiresAt, 10),
    lastActivityAt: parseInt(hash.lastActivityAt, 10),
    lastHeartbeatAt: parseInt(hash.lastHeartbeatAt, 10),
    firecrackerPid: parseInt(hash.firecrackerPid, 10),
    workerInstanceId: hash.workerInstanceId,
    defaultSessionId: hash.defaultSessionId || undefined,
    guestIp: hash.guestIp || undefined,
    workerHost: hash.workerHost || undefined,
  };
}

// ---------------------------------------------------------------------------
// Session Store
// ---------------------------------------------------------------------------

class SessionStore {
  private redis: Redis | null = null;

  /**
   * Lazily initialize the Redis connection using REDIS_URL (same as BullMQ).
   */
  private getRedis(): Redis {
    if (!this.redis) {
      const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
      });

      this.redis.on("error", (err) => {
        logger.error("SessionStore Redis error", { error: err.message });
      });
    }
    return this.redis;
  }

  /**
   * Save a full session record to Redis.
   * Also adds the workspaceId to the agent's index set.
   */
  async save(record: SessionRecord): Promise<void> {
    const redis = this.getRedis();
    const key = workspaceKey(record.workspaceId);
    const data = serializeRecord(record);

    const pipeline = redis.pipeline();
    pipeline.del(key);
    pipeline.hset(key, data);
    // Set a generous TTL — sessions that outlive this are truly orphaned
    // 24 hours is well beyond any normal workspace lifetime (max 4h default)
    pipeline.expire(key, 86400);
    // Index by agent
    pipeline.sadd(agentIndexKey(record.agentId), record.workspaceId);
    await pipeline.exec();
  }

  /**
   * Cache minimal workspace routing metadata for API-only workers.
   * Stores owner worker host, latest known vmId, and guest IP for traffic
   * direction without requiring an in-memory local session.
   */
  async saveWorkspaceRoute(record: WorkspaceRouteRecord): Promise<void> {
    const redis = this.getRedis();
    const key = `${WORKSPACE_ROUTE_PREFIX}${record.workspaceId}`;
    const payload = {
      workspaceId: record.workspaceId,
      workerHost: record.workerHost,
      vmId: record.vmId || "",
      guestIp: record.guestIp || "",
      status: record.status || "ready",
      lastUpdatedAt: String(record.lastUpdatedAt),
    };
    await redis.hset(key, payload);
    await redis.expire(key, 86400);
  }

  /**
   * Resolve cached routing metadata for a workspace.
   */
  async getWorkspaceRoute(workspaceId: string): Promise<WorkspaceRouteRecord | null> {
    const redis = this.getRedis();
    const hash = await redis.hgetall(`${WORKSPACE_ROUTE_PREFIX}${workspaceId}`);
    if (!hash || Object.keys(hash).length === 0) return null;

    if (!hash.workspaceId || !hash.workerHost) return null;

    return {
      workspaceId: hash.workspaceId,
      workerHost: hash.workerHost,
      vmId: hash.vmId || undefined,
      guestIp: hash.guestIp || undefined,
      status: hash.status,
      lastUpdatedAt: Number(hash.lastUpdatedAt || 0),
    };
  }

  /**
   * Remove cached routing metadata after workspace destruction.
   */
  async deleteWorkspaceRoute(workspaceId: string): Promise<void> {
    const redis = this.getRedis();
    await redis.del(`${WORKSPACE_ROUTE_PREFIX}${workspaceId}`);
  }

  /**
   * Get a session record by workspaceId.
   * Returns null if not found.
   */
  async get(workspaceId: string): Promise<SessionRecord | null> {
    const redis = this.getRedis();
    const hash = await redis.hgetall(workspaceKey(workspaceId));
    if (!hash || Object.keys(hash).length === 0) return null;
    return deserializeRecord(hash);
  }

  /**
   * Get all workspace IDs owned by an agent.
   */
  async getByAgent(agentId: string): Promise<string[]> {
    const redis = this.getRedis();
    return redis.smembers(agentIndexKey(agentId));
  }

  /**
   * Update just the status field of a session.
   */
  async updateStatus(
    workspaceId: string,
    status: SessionRecord["status"],
  ): Promise<void> {
    const redis = this.getRedis();
    await redis.hset(workspaceKey(workspaceId), "status", status);
  }

  /**
   * Touch the lastActivityAt timestamp for idle tracking.
   */
  async updateActivity(workspaceId: string): Promise<void> {
    const redis = this.getRedis();
    await redis.hset(
      workspaceKey(workspaceId),
      "lastActivityAt",
      String(Date.now()),
    );
  }

  /**
   * Update the lastHeartbeatAt timestamp for liveness tracking.
   */
  async updateHeartbeat(workspaceId: string): Promise<void> {
    const redis = this.getRedis();
    await redis.hset(
      workspaceKey(workspaceId),
      "lastHeartbeatAt",
      String(Date.now()),
    );
  }

  /**
   * Delete a session record and remove it from the agent index.
   */
  async delete(workspaceId: string): Promise<void> {
    const redis = this.getRedis();

    // Read agentId before deleting so we can clean up the index
    const agentId = await redis.hget(workspaceKey(workspaceId), "agentId");

    const pipeline = redis.pipeline();
    pipeline.del(workspaceKey(workspaceId));
    if (agentId) {
      pipeline.srem(agentIndexKey(agentId), workspaceId);
    }
    await pipeline.exec();
  }

  /**
   * List all active (non-destroyed) sessions across all workers.
   * Uses SCAN to avoid blocking Redis on large keyspaces.
   */
  async listActive(): Promise<SessionRecord[]> {
    const redis = this.getRedis();
    const sessions: SessionRecord[] = [];
    let cursor = "0";

    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${KEY_PREFIX}*`,
        "COUNT",
        100,
      );
      cursor = nextCursor;

      // Filter out index keys (by-agent:) and heartbeat keys
      const sessionKeys = keys.filter(
        (k) =>
          !k.startsWith(AGENT_INDEX_PREFIX) &&
          !k.startsWith(WORKER_HEARTBEAT_PREFIX),
      );

      for (const key of sessionKeys) {
        const hash = await redis.hgetall(key);
        const record = deserializeRecord(hash);
        if (record && record.status !== "destroyed") {
          sessions.push(record);
        }
      }
    } while (cursor !== "0");

    return sessions;
  }

  /**
   * Set the worker instance heartbeat in Redis with a 30-second TTL.
   * Other workers check this to determine if the owning worker is still alive.
   */
  async setWorkerHeartbeat(instanceId: string): Promise<void> {
    const redis = this.getRedis();
    await redis.set(
      workerHeartbeatKey(instanceId),
      String(Date.now()),
      "EX",
      30,
    );
  }

  /**
   * Check whether a worker instance heartbeat key still exists.
   * Returns the timestamp if alive, null if expired/missing.
   */
  async getWorkerHeartbeat(instanceId: string): Promise<number | null> {
    const redis = this.getRedis();
    const val = await redis.get(workerHeartbeatKey(instanceId));
    return val ? parseInt(val, 10) : null;
  }

  /**
   * Update the workerInstanceId on an existing session (for adoption).
   */
  async adoptSession(
    workspaceId: string,
    newWorkerInstanceId: string,
  ): Promise<void> {
    const redis = this.getRedis();
    await redis.hset(
      workspaceKey(workspaceId),
      "workerInstanceId",
      newWorkerInstanceId,
    );
  }

  /**
   * Ping Redis to verify connectivity. Throws if unreachable.
   */
  async ping(): Promise<void> {
    const redis = this.getRedis();
    const result = await redis.ping();
    if (result !== "PONG") throw new Error(`Redis ping returned: ${result}`);
  }

  /**
   * Gracefully close the Redis connection.
   */
  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const sessionStore = new SessionStore();
export default sessionStore;
