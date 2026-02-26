export type RateLimitStore = "memory" | "redis";
export type StartupMode = "full" | "registration-only";

export interface ServerConfig {
  convexUrl: string;
  mcpSharedSecret?: string;
  arcagentApiKey?: string;
  workerSharedSecret?: string;
  clerkSecretKey?: string;
  mcpPort: number;
  transport: "stdio" | "http";
  requireAuthOnStreams: boolean;
  sessionTtlMs: number;
  maxSessions: number;
  jsonBodyLimit: string;
  rateLimitStore: RateLimitStore;
  rateLimitRedisUrl?: string;
  startupMode: StartupMode;
}

const DEFAULT_CONVEX_URL = "https://acoustic-starfish-282.convex.site";

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fallback;
}

export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const transport = env.MCP_TRANSPORT === "http" ? "http" : "stdio";
  const rateLimitStore: RateLimitStore = env.RATE_LIMIT_STORE === "redis"
    ? "redis"
    : "memory";
  const startupMode: StartupMode = env.MCP_STARTUP_MODE === "registration-only"
    ? "registration-only"
    : "full";

  return {
    convexUrl: env.CONVEX_URL || DEFAULT_CONVEX_URL,
    mcpSharedSecret: env.MCP_SHARED_SECRET,
    arcagentApiKey: env.ARCAGENT_API_KEY,
    workerSharedSecret: env.WORKER_SHARED_SECRET,
    clerkSecretKey: env.CLERK_SECRET_KEY,
    mcpPort: parseIntEnv(env.MCP_PORT, 3002),
    transport,
    requireAuthOnStreams: parseBoolEnv(env.MCP_REQUIRE_AUTH_ON_STREAMS, true),
    sessionTtlMs: parseIntEnv(env.MCP_SESSION_TTL_MS, 900_000),
    maxSessions: parseIntEnv(env.MCP_MAX_SESSIONS, 5_000),
    jsonBodyLimit: env.MCP_JSON_BODY_LIMIT || "1mb",
    rateLimitStore,
    rateLimitRedisUrl: env.RATE_LIMIT_REDIS_URL || env.REDIS_URL,
    startupMode,
  };
}

export function assertConfig(config: ServerConfig): void {
  if (config.startupMode === "registration-only") {
    if (config.transport !== "http") {
      throw new Error("MCP_STARTUP_MODE=registration-only requires MCP_TRANSPORT=http");
    }
    return;
  }
}
