/**
 * Direct HTTP client for workspace operations on the worker.
 *
 * Bypasses Convex for latency-sensitive interactive operations
 * (exec, file read/write). Auth: short-lived scoped worker tokens minted by Convex.
 */

import { callConvex } from "../convex/client";
import { getAuthApiKey } from "../lib/context";

let workerSecret: string | undefined;

const DEFAULT_TIMEOUT_MS = 130_000; // slightly over max command timeout
const TOKEN_REFRESH_BUFFER_MS = 5_000;

interface WorkerTokenCacheEntry {
  token: string;
  expiresAt: number;
}

const workerTokenCache = new Map<string, WorkerTokenCacheEntry>();

export class WorkerHttpError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message: string) {
    super(message);
    this.name = "WorkerHttpError";
    this.status = status;
    this.path = path;
  }
}

function getTokenCacheKey(workspaceId: string, routePath: string): string {
  const authKey = getAuthApiKey() ?? "stdio";
  return `${authKey}:${workspaceId}:${routePath}`;
}

async function getWorkerAuthorizationHeader(
  routePath: string,
  body: Record<string, unknown>,
): Promise<string> {
  if (workerSecret) {
    return `Bearer ${workerSecret}`;
  }

  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  if (!workspaceId) {
    throw new Error("Missing workspaceId for worker request");
  }

  const cacheKey = getTokenCacheKey(workspaceId, routePath);
  const cached = workerTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return `Bearer ${cached.token}`;
  }

  const tokenResponse = await callConvex<{ token: string; expiresAt: number }>(
    "/api/mcp/workspace/token",
    {
      workspaceId,
      routePath,
    },
  );

  workerTokenCache.set(cacheKey, tokenResponse);
  return `Bearer ${tokenResponse.token}`;
}

export function initWorkerClient(secret: string): void {
  workerSecret = secret;
}

export async function callWorker<T = unknown>(
  workerHost: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const url = `${workerHost.replace(/\/+$/, "")}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const authorization = await getWorkerAuthorizationHeader(path, body);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const rawText = await response.text().catch(() => "");
      let errorMessage: string;
      try {
        const parsed = JSON.parse(rawText);
        errorMessage = parsed.error || parsed.message || rawText.slice(0, 200);
      } catch {
        errorMessage = `Worker error (${response.status}). ${rawText.slice(0, 200)}`;
      }
      throw new WorkerHttpError(response.status, path, errorMessage);
    }

    return (await response.json()) as T;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Worker request timed out: ${path}`);
    }
    throw err;
  }
}
