export type RateLimitStore = "memory" | "redis";
export type StartupMode = "full" | "registration-only";
export type SessionMode = "stateful" | "stateless";

export interface ServerConfig {
  convexUrl: string;
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
  sessionMode: SessionMode;
  publicBaseUrl?: string;
  allowedHosts: string[];
  requireHttps: boolean;
  registerHoneypotField?: string;
  registerCaptchaHeader: string;
  registerCaptchaSecret?: string;
  enableConvexAuditLogs: boolean;
  convexAuditLogToken?: string;
  internalWorkerBaseUrl?: string;
  workerProxyPathPrefix: string;
}

const DEFAULT_CONVEX_URL = "https://acoustic-starfish-282.convex.site";
const CLOUD_SUFFIX = ".convex.cloud";
const SITE_SUFFIX = ".convex.site";

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

function parseListEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeConvexHttpActionsUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname.endsWith(CLOUD_SUFFIX)) {
    parsed.hostname = `${parsed.hostname.slice(0, -CLOUD_SUFFIX.length)}${SITE_SUFFIX}`;
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizePublicBaseUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const parsed = new URL(url);
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeHttpBaseUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const parsed = new URL(url);
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeProxyPathPrefix(path: string | undefined): string {
  if (!path) return "/worker-proxy";
  const trimmed = path.trim();
  if (!trimmed) return "/worker-proxy";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/worker-proxy";
}

function getDefaultAllowedHosts(publicBaseUrl?: string): string[] {
  if (!publicBaseUrl) return [];
  try {
    return [new URL(publicBaseUrl).hostname.toLowerCase()];
  } catch {
    return [];
  }
}

export function isHostedRuntime(config: ServerConfig): boolean {
  return (
    config.transport === "http" && (
      Boolean(config.publicBaseUrl) ||
      config.allowedHosts.length > 0 ||
      config.requireHttps
    )
  );
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
  const sessionMode: SessionMode = env.MCP_SESSION_MODE === "stateless"
    ? "stateless"
    : "stateful";
  const convexBaseUrl = env.CONVEX_HTTP_ACTIONS_URL || env.CONVEX_URL || DEFAULT_CONVEX_URL;
  const publicBaseUrl = normalizePublicBaseUrl(env.MCP_PUBLIC_BASE_URL);
  const configuredAllowedHosts = parseListEnv(env.MCP_ALLOWED_HOSTS);
  const allowedHosts = configuredAllowedHosts.length > 0
    ? configuredAllowedHosts
    : getDefaultAllowedHosts(publicBaseUrl);

  return {
    convexUrl: normalizeConvexHttpActionsUrl(convexBaseUrl),
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
    sessionMode,
    publicBaseUrl,
    allowedHosts,
    requireHttps: parseBoolEnv(env.MCP_REQUIRE_HTTPS, false),
    registerHoneypotField: env.MCP_REGISTER_HONEYPOT_FIELD || "website",
    registerCaptchaHeader: (env.MCP_REGISTER_CAPTCHA_HEADER || "x-arcagent-captcha-token")
      .toLowerCase(),
    registerCaptchaSecret: env.MCP_REGISTER_CAPTCHA_SECRET,
    enableConvexAuditLogs: parseBoolEnv(env.MCP_ENABLE_CONVEX_AUDIT_LOGS, false),
    convexAuditLogToken: env.MCP_AUDIT_LOG_TOKEN,
    internalWorkerBaseUrl: normalizeHttpBaseUrl(env.MCP_INTERNAL_WORKER_BASE_URL),
    workerProxyPathPrefix: normalizeProxyPathPrefix(env.MCP_WORKER_PROXY_PATH_PREFIX),
  };
}

export function assertConfig(config: ServerConfig): void {
  if (config.startupMode === "registration-only") {
    if (config.transport !== "http") {
      throw new Error("MCP_STARTUP_MODE=registration-only requires MCP_TRANSPORT=http");
    }
  }

  if (config.publicBaseUrl) {
    const parsed = new URL(config.publicBaseUrl);
    if (parsed.protocol !== "https:") {
      throw new Error("MCP_PUBLIC_BASE_URL must use https://");
    }
  }

  if (config.rateLimitStore === "redis" && !config.rateLimitRedisUrl) {
    throw new Error("RATE_LIMIT_STORE=redis requires RATE_LIMIT_REDIS_URL (or REDIS_URL)");
  }

  if (isHostedRuntime(config) && config.rateLimitStore !== "redis") {
    throw new Error("Hosted HTTP runtime requires RATE_LIMIT_STORE=redis");
  }

  if (config.enableConvexAuditLogs && !config.convexAuditLogToken) {
    throw new Error("MCP_ENABLE_CONVEX_AUDIT_LOGS=true requires MCP_AUDIT_LOG_TOKEN");
  }
}
