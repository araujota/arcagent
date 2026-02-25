import type { SessionRecord } from "./types";

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSessions: number,
  ) {}

  setOwned(sessionId: string, userId: string): SessionRecord {
    const now = Date.now();
    const existing = this.sessions.get(sessionId);
    const record: SessionRecord = existing
      ? {
        ...existing,
        userId,
        lastSeenAt: now,
        expiresAt: now + this.ttlMs,
      }
      : {
        sessionId,
        userId,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + this.ttlMs,
      };

    this.sessions.set(sessionId, record);
    this.evictIfNeeded();
    return record;
  }

  get(sessionId: string): SessionRecord | undefined {
    const existing = this.sessions.get(sessionId);
    if (!existing) return undefined;
    if (existing.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return undefined;
    }

    const updated: SessionRecord = {
      ...existing,
      lastSeenAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  size(): number {
    return this.sessions.size;
  }

  cleanupExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, value] of this.sessions) {
      if (value.expiresAt <= now) {
        this.sessions.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.sessions.clear();
  }

  private evictIfNeeded(): void {
    while (this.sessions.size > this.maxSessions) {
      let oldestKey: string | undefined;
      let oldestLastSeen = Number.POSITIVE_INFINITY;
      for (const [key, value] of this.sessions) {
        if (value.lastSeenAt < oldestLastSeen) {
          oldestLastSeen = value.lastSeenAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.sessions.delete(oldestKey);
    }
  }
}
