#!/usr/bin/env node
import { randomUUID } from "crypto";
import { createServer, Server as HttpServer } from "http";
import express, { type Request, type Response } from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { validateApiKey, extractApiKey, getApiKeyAuthCacheSize } from "./auth/apiKeyAuth";
import { loadServerConfig, assertConfig, isHostedRuntime, type ServerConfig } from "./config";
import { initConvexClient, callConvex } from "./convex/client";
import { runWithAuth, setStdioAuthUser } from "./lib/context";
import { sendError } from "./lib/httpError";
import { createRateLimiter } from "./lib/rateLimit";
import { SessionStore } from "./lib/sessionStore";
import { HttpTelemetry } from "./lib/telemetry";
import { createMcpServer } from "./server";
import { initWorkerClient } from "./worker/client";
import { getWorkspaceCacheSize } from "./workspace/cache";

interface HttpRuntime {
  app: express.Express;
  close: () => Promise<void>;
  sessions: SessionStore;
}

interface StaticServerCard {
  $schema: string;
  serverInfo: {
    name: string;
    version: string;
    title: string;
    description: string;
    websiteUrl: string;
    sourceCodeUrl: string;
    iconUrl: string;
  };
  hosting: {
    platform: string;
    hostingType: "remote";
    regions: string[];
  };
  capabilities: {
    tools: Array<{ name: string; description: string }>;
    resources: Array<{ uri: string; name: string; description: string }>;
    prompts: Array<{ name: string; description: string }>;
  };
  authentication: {
    type: "apiKey";
    in: "header";
    name: "Authorization";
    scheme: "Bearer";
    instructions: string;
  };
  endpoints: {
    mcp: string;
    registration: string;
    health: string;
  };
}

type LogLevel = "info" | "warning" | "error";

type SearchableIds = {
  agentId?: string;
  bountyId?: string;
  claimId?: string;
  submissionId?: string;
  verificationId?: string;
  workspaceId?: string;
};

type RequestWithMeta = Request & {
  mcpRequestId?: string;
  mcpAgentId?: string;
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const SEARCHABLE_ID_KEYS = new Set([
  "agentid",
  "userid",
  "bountyid",
  "claimid",
  "submissionid",
  "verificationid",
  "workspaceid",
]);

const MCP_SERVER_VERSION = "0.1.12";

function buildStaticServerCard(config: ServerConfig): StaticServerCard {
  const base = config.publicBaseUrl || `http://localhost:${config.mcpPort}`;
  return {
    $schema: "https://smithery.ai/schemas/server-card.json",
    serverInfo: {
      name: "arcagent",
      version: MCP_SERVER_VERSION,
      title: "ArcAgent",
      description: "ArcAgent MCP server for bounty discovery, workspace execution, and verified coding submissions.",
      websiteUrl: "https://github.com/araujota/arcagent",
      sourceCodeUrl: "https://github.com/araujota/arcagent/tree/main/mcp-server",
      iconUrl: `${base}/icon.svg`,
    },
    hosting: {
      platform: "AWS Fargate",
      hostingType: "remote",
      regions: ["us-east-1"],
    },
    capabilities: {
      tools: [
        {
          name: "register_account",
          description: "Create a new ArcAgent account and issue an API key.",
        },
        {
          name: "list_bounties",
          description: "List active bounties with reward and deadline metadata.",
        },
        {
          name: "claim_bounty",
          description: "Claim an exclusive lock and workspace for a bounty.",
        },
        {
          name: "workspace_exec",
          description: "Run shell commands in the claimed bounty workspace.",
        },
        {
          name: "submit_solution",
          description: "Submit workspace diff for secure verification pipeline execution.",
        },
        {
          name: "get_verification_status",
          description: "Fetch verification gates, logs, and hidden-test summaries.",
        },
      ],
      resources: [
        {
          uri: "arcagent://overview",
          name: "ArcAgent MCP Overview",
          description: "Core capabilities and recommended execution workflow.",
        },
        {
          uri: "arcagent://connection",
          name: "ArcAgent Connection Guide",
          description: "Auth and endpoint details for remote MCP usage.",
        },
      ],
      prompts: [
        {
          name: "bounty_execution_plan",
          description: "Draft a scoped implementation plan before editing code.",
        },
        {
          name: "verification_triage",
          description: "Turn failed verification output into prioritized fixes.",
        },
      ],
    },
    authentication: {
      type: "apiKey",
      in: "header",
      name: "Authorization",
      scheme: "Bearer",
      instructions: "Set Authorization header to: Bearer arc_<api_key>",
    },
    endpoints: {
      mcp: `${base}/mcp`,
      registration: `${base}/api/mcp/register`,
      health: `${base}/health`,
    },
  };
}

function normalizeHost(rawHost: string | undefined): string | null {
  if (!rawHost) return null;
  const first = rawHost.split(",")[0]?.trim().toLowerCase();
  if (!first) return null;
  const withoutPort = first.replace(/:\d+$/, "");
  return withoutPort || null;
}

function extractSearchableIds(payload: unknown): SearchableIds {
  const result: SearchableIds = {};
  const visited = new Set<object>();

  const setIfMissing = (key: string, value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "userid" || normalizedKey === "agentid") {
      result.agentId ||= value;
      return;
    }
    if (normalizedKey === "bountyid") result.bountyId ||= value;
    if (normalizedKey === "claimid") result.claimId ||= value;
    if (normalizedKey === "submissionid") result.submissionId ||= value;
    if (normalizedKey === "verificationid") result.verificationId ||= value;
    if (normalizedKey === "workspaceid") result.workspaceId ||= value;
  };

  const walk = (value: unknown, depth: number) => {
    if (depth > 5) return;
    if (!value || typeof value !== "object") return;
    if (visited.has(value as object)) return;
    visited.add(value as object);

    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }

    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SEARCHABLE_ID_KEYS.has(key.toLowerCase())) {
        setIfMissing(key, nested);
      }
      walk(nested, depth + 1);
    }
  };

  walk(payload, 0);
  return result;
}

// Used by directory scanners (for example Smithery) to enumerate capabilities
// without requiring production credentials or workspace secrets.
export function createSandboxServer() {
  return createMcpServer({
    enableWorkspaceTools: false,
    enableRegistration: true,
  });
}

async function authenticateRequest(req: Request): Promise<{
  ok: true;
  apiKey: string;
  userId: string;
  user: Awaited<ReturnType<typeof validateApiKey>>;
} | {
  ok: false;
  status: number;
  code: string;
  message: string;
}> {
  const apiKey = extractApiKey(req.headers.authorization);
  if (!apiKey) {
    return {
      ok: false,
      status: 401,
      code: "missing_api_key",
      message: "Missing API key",
    };
  }

  try {
    const user = await validateApiKey(apiKey);
    if (!user) {
      return {
        ok: false,
        status: 403,
        code: "invalid_api_key",
        message: "Invalid API key",
      };
    }
    return { ok: true, apiKey, userId: user.userId, user };
  } catch (error) {
    return {
      ok: false,
      status: 403,
      code: "invalid_api_key",
      message: error instanceof Error ? error.message : "Invalid API key",
    };
  }
}

function buildWorkerProxyTargetUrl(baseUrl: string, requestUrl: string): string {
  return `${baseUrl}${requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`}`;
}

function copyProxyRequestHeaders(source: Request["headers"]): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(source)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase()) || value === undefined) continue;
    if (Array.isArray(value)) {
      headers.set(key, value.join(","));
      continue;
    }
    if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  return headers;
}

function buildWorkerProxyRequestInit(req: Request, headers: Headers): RequestInit {
  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit = {
    method,
    headers,
    redirect: "manual",
  };
  if (!hasBody || req.body === undefined) {
    return init;
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  init.body = JSON.stringify(req.body);
  return init;
}

async function parseWorkerProxyJsonPayload(
  res: Response,
  upstream: Response,
): Promise<{ ok: boolean; payload?: unknown }> {
  const upstreamContentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
  if (!upstreamContentType.includes("application/json")) {
    sendError(
      res,
      502,
      "worker_proxy_invalid_content_type",
      "Worker response must be JSON",
    );
    return { ok: false };
  }
  const payloadText = await upstream.text();
  if (payloadText.length === 0) {
    return { ok: true, payload: null };
  }
  try {
    return { ok: true, payload: JSON.parse(payloadText) as unknown };
  } catch {
    sendError(
      res,
      502,
      "worker_proxy_invalid_json",
      "Worker response body was not valid JSON",
    );
    return { ok: false };
  }
}

function createWorkerProxyHandler(config: ServerConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    const headers = copyProxyRequestHeaders(req.headers);
    const init = buildWorkerProxyRequestInit(req, headers);
    const targetUrl = buildWorkerProxyTargetUrl(config.internalWorkerBaseUrl!, req.url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 130_000);
    init.signal = controller.signal;

    try {
      const upstream = await fetch(targetUrl, init);
      const parsed = await parseWorkerProxyJsonPayload(res, upstream);
      if (!parsed.ok) return;
      res.status(upstream.status).json(parsed.payload);
    } catch (error) {
      sendError(
        res,
        502,
        "worker_proxy_error",
        error instanceof Error ? error.message : "Failed to proxy worker request",
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}

type RegisterRequestMeta = {
  requestId: string | undefined;
  ip: string;
  isOAuthCompatibilityRoute: boolean;
};

type EmitAuditLogFn = (
  level: LogLevel,
  eventType: string,
  message: string,
  details?: Record<string, unknown>,
) => void;

function getRegisterRequestMeta(req: Request): RegisterRequestMeta {
  return {
    requestId: (req as RequestWithMeta).mcpRequestId,
    ip: req.ip || req.socket.remoteAddress || "unknown",
    isOAuthCompatibilityRoute: req.path === "/register",
  };
}

async function rejectAlreadyAuthenticatedRegistration(
  req: Request,
  res: Response,
  telemetry: HttpTelemetry,
  emitAuditLog: EmitAuditLogFn,
  meta: RegisterRequestMeta,
): Promise<boolean> {
  const presentedApiKey = extractApiKey(req.headers.authorization);
  if (!presentedApiKey) return false;
  const existingAuth = await validateApiKey(presentedApiKey);
  if (!existingAuth) return false;

  telemetry.recordRegisterFailure();
  emitAuditLog(
    "warning",
    "register_already_authenticated",
    "Blocked registration attempt from authenticated session",
    {
      requestId: meta.requestId,
      ip: meta.ip,
      userId: existingAuth.userId,
      email: existingAuth.email,
    },
  );
  sendError(
    res,
    409,
    "already_authenticated",
    "Already authenticated. Reuse the current API key instead of registering again.",
  );
  return true;
}

function deriveRegisterEmailKey(req: Request, meta: RegisterRequestMeta): string {
  if (typeof req.body?.email === "string") {
    return req.body.email.trim().toLowerCase();
  }
  if (meta.isOAuthCompatibilityRoute) {
    return `oauth:${meta.ip}`;
  }
  return "unknown";
}

function rejectRegisterByHoneypot(
  req: Request,
  res: Response,
  config: ServerConfig,
  telemetry: HttpTelemetry,
  emitAuditLog: EmitAuditLogFn,
  meta: RegisterRequestMeta,
): boolean {
  if (!config.registerHoneypotField) return false;
  const honeypotValue = req.body?.[config.registerHoneypotField];
  if (typeof honeypotValue !== "string" || !honeypotValue.trim()) return false;

  telemetry.recordRegisterFailure();
  emitAuditLog("warning", "register_honeypot_blocked", "Blocked registration by honeypot field", {
    requestId: meta.requestId,
    ip: meta.ip,
    honeypotField: config.registerHoneypotField,
  });
  res.status(202).json({ status: "accepted" });
  return true;
}

function rejectRegisterByCaptcha(
  req: Request,
  res: Response,
  config: ServerConfig,
  telemetry: HttpTelemetry,
  emitAuditLog: EmitAuditLogFn,
  meta: RegisterRequestMeta,
): boolean {
  if (!config.registerCaptchaSecret) return false;
  const captchaToken = req.headers[config.registerCaptchaHeader]?.toString() || "";
  if (captchaToken === config.registerCaptchaSecret) return false;

  telemetry.recordRegisterFailure();
  emitAuditLog("warning", "register_captcha_failed", "Blocked registration due to missing/invalid captcha token", {
    requestId: meta.requestId,
    ip: meta.ip,
  });
  sendError(res, 403, "captcha_required", "Captcha verification failed");
  return true;
}

async function enforceRegisterRateLimits(
  res: Response,
  registerLimiter: ReturnType<typeof createRateLimiter>,
  telemetry: HttpTelemetry,
  emitAuditLog: EmitAuditLogFn,
  meta: RegisterRequestMeta,
  emailKey: string,
): Promise<boolean> {
  const ipAllowed = await registerLimiter.check(`register:ip:${meta.ip}`, 20, 60_000);
  if (!ipAllowed) {
    telemetry.recordRateLimited();
    telemetry.recordRegisterRateLimited();
    emitAuditLog("warning", "register_rate_limited", "Rate limited registration attempt by IP", {
      requestId: meta.requestId,
      ip: meta.ip,
    });
    sendError(res, 429, "register_rate_limited", "Too many registration attempts", true);
    return false;
  }

  const emailAllowed = await registerLimiter.check(
    `register:email:${emailKey}`,
    5,
    60_000,
  );
  if (emailAllowed) return true;

  telemetry.recordRateLimited();
  telemetry.recordRegisterRateLimited();
  emitAuditLog("warning", "register_rate_limited", "Rate limited registration attempt by email", {
    requestId: meta.requestId,
    ip: meta.ip,
    email: emailKey,
  });
  sendError(res, 429, "register_rate_limited", "Too many registration attempts", true);
  return false;
}

function maybeHandleOAuthCompatibilityRegistration(
  req: Request,
  res: Response,
  telemetry: HttpTelemetry,
  emitAuditLog: EmitAuditLogFn,
  meta: RegisterRequestMeta,
  name?: string,
  email?: string,
): boolean {
  if (!meta.isOAuthCompatibilityRoute || (name && email)) return false;
  const redirectUris = Array.isArray(req.body?.redirect_uris)
    ? req.body.redirect_uris.filter((uri): uri is string => typeof uri === "string")
    : [];
  const issuedAt = Math.floor(Date.now() / 1000);

  res.status(201).json({
    client_id: `arcagent_${randomUUID().replaceAll("-", "")}`,
    client_secret: randomUUID().replaceAll("-", ""),
    client_id_issued_at: issuedAt,
    client_secret_expires_at: 0,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "client_secret_post",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  telemetry.recordRegisterSuccess();
  emitAuditLog("info", "register_oauth_compat", "Returned OAuth-compatible registration payload", {
    requestId: meta.requestId,
    ip: meta.ip,
  });
  return true;
}

export async function createHttpRuntime(config: ServerConfig): Promise<HttpRuntime> {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: config.jsonBodyLimit }));

  const telemetry = new HttpTelemetry();
  const requestLimiter = createRateLimiter({
    store: config.rateLimitStore,
    redisUrl: config.rateLimitRedisUrl,
  });
  const registerLimiter = createRateLimiter({
    store: config.rateLimitStore,
    redisUrl: config.rateLimitRedisUrl,
  });
  const statefulSessions = config.sessionMode === "stateful";
  const sessions = new SessionStore(config.sessionTtlMs, config.maxSessions);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const cleanupTimer = statefulSessions
    ? setInterval(() => {
      const removed = sessions.cleanupExpired();
      if (removed === 0) return;
      for (const [sessionId, transport] of transports) {
        if (!sessions.get(sessionId)) {
          transports.delete(sessionId);
          transport.close().catch(() => {});
        }
      }
    }, 30_000)
    : undefined;
  cleanupTimer?.unref();

  const serverOptions = {
    enableWorkspaceTools: true,
    enableRegistration: true,
  };

  const emitAuditLog = (
    level: LogLevel,
    eventType: string,
    message: string,
    details: Record<string, unknown> = {},
  ) => {
    const payload = {
      source: "mcp_server",
      level,
      eventType,
      message,
      createdAt: Date.now(),
      ...details,
    };
    console.log(JSON.stringify(payload));
    if (!config.enableConvexAuditLogs) return;
    void callConvex("/api/mcp/logs/ingest", payload, {
      authToken: config.convexAuditLogToken,
    }).catch((error) => {
      console.error(
        JSON.stringify({
          source: "mcp_server",
          level: "warning",
          eventType: "audit_log_ingest_failed",
          message: error instanceof Error ? error.message : "Failed to mirror audit log to Convex",
          createdAt: Date.now(),
        }),
      );
    });
  };

  app.use((req, res, next) => {
    const startedAt = Date.now();
    const requestId = req.headers["x-request-id"]?.toString() || randomUUID();
    const requestMeta = req as RequestWithMeta;
    requestMeta.mcpRequestId = requestId;
    res.setHeader("x-request-id", requestId);

    res.on("finish", () => {
      const latencyMs = Date.now() - startedAt;
      const ids = extractSearchableIds(req.body);
      const headerSessionId = req.headers["mcp-session-id"]?.toString();
      const level: LogLevel = res.statusCode >= 500
        ? "error"
        : res.statusCode >= 400
          ? "warning"
          : "info";
      const method = typeof req.body?.method === "string" ? req.body.method : undefined;

      telemetry.recordRequest(latencyMs);
      emitAuditLog(level, "http_request", "HTTP request completed", {
        requestId,
        path: req.path,
        method: req.method,
        statusCode: res.statusCode,
        durationMs: latencyMs,
        sessionId: headerSessionId,
        agentId: requestMeta.mcpAgentId || ids.agentId,
        bountyId: ids.bountyId,
        claimId: ids.claimId,
        submissionId: ids.submissionId,
        verificationId: ids.verificationId,
        workspaceId: ids.workspaceId,
        rpcMethod: method,
      });
    });

    next();
  });

  if (config.allowedHosts.length > 0 || config.requireHttps) {
    app.use((req, res, next) => {
      const requestId = (req as RequestWithMeta).mcpRequestId;
      if (req.path === "/health") {
        next();
        return;
      }
      if (config.allowedHosts.length > 0) {
        const host = normalizeHost(
          req.headers["x-forwarded-host"]?.toString() ||
          req.headers.host?.toString(),
        );
        if (!host || !config.allowedHosts.includes(host)) {
          emitAuditLog("warning", "host_rejected", "Rejected request for untrusted host header", {
            requestId,
            path: req.path,
            method: req.method,
            host,
          });
          sendError(res, 403, "host_not_allowed", "Host is not allowed");
          return;
        }
      }

      if (config.requireHttps) {
        const forwardedProto = req.headers["x-forwarded-proto"]?.toString().split(",")[0]?.trim();
        const proto = (forwardedProto || req.protocol || "").toLowerCase();
        if (proto !== "https") {
          emitAuditLog("warning", "https_required", "Rejected non-HTTPS request in hosted mode", {
            requestId,
            path: req.path,
            method: req.method,
            forwardedProto: forwardedProto || null,
          });
          sendError(res, 400, "https_required", "HTTPS is required");
          return;
        }
      }

      next();
    });
  }

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "arcagent-mcp",
      rateLimitStore: requestLimiter.mode(),
      sessionMode: config.sessionMode,
      hostedRuntime: isHostedRuntime(config),
    });
  });

  app.get("/metrics", (_req, res) => {
    res.json({
      ...telemetry.snapshot(statefulSessions ? sessions.size() : 0),
      apiKeyCacheSize: getApiKeyAuthCacheSize(),
      workspaceCacheSize: getWorkspaceCacheSize(),
      sessionMode: config.sessionMode,
    });
  });

  app.get("/.well-known/mcp/server-card.json", (_req, res) => {
    res.setHeader("cache-control", "public, max-age=300");
    res.json(buildStaticServerCard(config));
  });

  app.get("/icon.svg", (_req, res) => {
    res.setHeader("cache-control", "public, max-age=86400");
    res.type("image/svg+xml").send(
      [
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 128 128\" role=\"img\" aria-label=\"ArcAgent\">",
        "<rect width=\"128\" height=\"128\" rx=\"24\" fill=\"#0f172a\"/>",
        "<path d=\"M24 92 L64 20 L104 92 Z\" fill=\"#22c55e\"/>",
        "<circle cx=\"64\" cy=\"74\" r=\"12\" fill=\"#0f172a\"/>",
        "</svg>",
      ].join(""),
    );
  });

  if (config.internalWorkerBaseUrl) {
    const proxyPrefix = config.workerProxyPathPrefix;
    app.use(proxyPrefix, createWorkerProxyHandler(config));
  }

  const handleRegister = async (req: Request, res: Response) => {
    telemetry.recordRegisterAttempt();
    const meta = getRegisterRequestMeta(req);

    if (await rejectAlreadyAuthenticatedRegistration(req, res, telemetry, emitAuditLog, meta)) return;
    if (rejectRegisterByHoneypot(req, res, config, telemetry, emitAuditLog, meta)) return;
    if (rejectRegisterByCaptcha(req, res, config, telemetry, emitAuditLog, meta)) return;

    const emailKey = deriveRegisterEmailKey(req, meta);
    const withinRateLimit = await enforceRegisterRateLimits(
      res,
      registerLimiter,
      telemetry,
      emitAuditLog,
      meta,
      emailKey,
    );
    if (!withinRateLimit) return;

    try {
      const { name, email, githubUsername } = req.body as {
        name?: string;
        email?: string;
        githubUsername?: string;
      };

      if (maybeHandleOAuthCompatibilityRegistration(req, res, telemetry, emitAuditLog, meta, name, email)) {
        return;
      }

      if (!name || !email) {
        telemetry.recordRegisterFailure();
        sendError(res, 400, "bad_request", "name and email are required");
        return;
      }

      const result = await callConvex<{ userId: string; apiKey: string; keyPrefix: string }>(
        "/api/mcp/agents/create",
        {
          name,
          email,
          githubUsername,
        },
      );

      res.json({
        userId: result.userId,
        apiKey: result.apiKey,
        keyPrefix: result.keyPrefix,
        message: "Store this API key securely. It will not be shown again.",
      });
      telemetry.recordRegisterSuccess();
      emitAuditLog("info", "register_success", "Issued API key for new MCP registration", {
        requestId: meta.requestId,
        email: email.trim().toLowerCase(),
        userId: result.userId,
      });
    } catch (error) {
      telemetry.recordRegisterFailure();
      emitAuditLog("error", "register_failed", "MCP registration failed", {
        requestId: meta.requestId,
        error: error instanceof Error ? error.message : "Registration failed",
      });
      sendError(
        res,
        400,
        "registration_failed",
        error instanceof Error ? error.message : "Registration failed",
      );
    }
  };

  app.post("/api/mcp/register", handleRegister);
  // Compatibility alias used by some MCP directory scanners.
  app.post("/register", handleRegister);

  app.post("/mcp", async (req, res) => {
    if (config.startupMode === "registration-only") {
      sendError(
        res,
        503,
        "registration_only_mode",
        "MCP tool transport is disabled in registration-only startup mode",
      );
      return;
    }

    const startedAt = Date.now();
    const requestMeta = req as RequestWithMeta;
    const rpcMethod = typeof req.body?.method === "string" ? req.body.method : undefined;
    const auth = await authenticateRequest(req);
    if (!auth.ok) {
      const isPublicDiscoveryMethod = rpcMethod === "initialize"
        || rpcMethod === "tools/list"
        || rpcMethod === "prompts/list"
        || rpcMethod === "resources/list"
        || rpcMethod === "resources/templates/list";
      if (isPublicDiscoveryMethod) {
        // Directory scanners often omit the MCP stream Accept header.
        // Normalize it in-place so streamable HTTP transport accepts discovery probes.
        const originalAccept = req.headers.accept;
        req.headers.accept = "application/json, text/event-stream";

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = createSandboxServer();
        await server.connect(transport);
        try {
          await transport.handleRequest(req, res, req.body);
        } finally {
          req.headers.accept = originalAccept;
        }
        await transport.close().catch(() => {});
        telemetry.recordToolRequest(Date.now() - startedAt, res.statusCode < 400);
        emitAuditLog("info", "unauthenticated_discovery_allowed", "Allowed unauthenticated MCP discovery request", {
          requestId: requestMeta.mcpRequestId,
          rpcMethod,
        });
        return;
      }

      telemetry.recordAuthFailure();
      emitAuditLog("warning", "auth_failed", "MCP request rejected due to authentication failure", {
        requestId: requestMeta.mcpRequestId,
        path: req.path,
        code: auth.code,
      });
      sendError(res, auth.status, auth.code, auth.message);
      return;
    }
    requestMeta.mcpAgentId = auth.userId;

    const allowed = await requestLimiter.check(`user:${auth.userId}`);
    if (!allowed) {
      telemetry.recordRateLimited();
      emitAuditLog("warning", "rate_limited", "MCP request rejected due to rate limiting", {
        requestId: requestMeta.mcpRequestId,
        agentId: auth.userId,
      });
      sendError(res, 429, "rate_limited", "Rate limit exceeded", true);
      return;
    }

    await runWithAuth(auth.user!, auth.apiKey, async () => {
      if (!statefulSessions) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = createMcpServer(serverOptions);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        await transport.close().catch(() => {});
        const durationMs = Date.now() - startedAt;
        telemetry.recordToolRequest(durationMs, res.statusCode < 400);
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId) {
        const record = sessions.get(sessionId);
        const transport = transports.get(sessionId);
        if (!record || !transport) {
          sendError(res, 400, "invalid_session", "Invalid or expired session");
          return;
        }
        if (record.userId !== auth.userId) {
          sendError(res, 403, "session_forbidden", "Session does not belong to this API key");
          return;
        }
        await transport.handleRequest(req, res, req.body);
        telemetry.recordToolRequest(Date.now() - startedAt, res.statusCode < 400);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.setOwned(newSessionId, auth.userId);
          transports.set(newSessionId, transport);
        },
      });

      transport.onclose = () => {
        const sid = (transport as unknown as { sessionId?: string }).sessionId;
        if (!sid) return;
        sessions.delete(sid);
        transports.delete(sid);
      };

      const server = createMcpServer(serverOptions);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      telemetry.recordToolRequest(Date.now() - startedAt, res.statusCode < 400);
    });
  });

  const validateStreamAccess = async (
    req: Request,
    res: Response,
  ): Promise<{ sessionId: string } | null> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      sendError(res, 400, "invalid_session", "Missing mcp-session-id header");
      return null;
    }

    const record = sessions.get(sessionId);
    const transport = transports.get(sessionId);
    if (!record || !transport) {
      sendError(res, 400, "invalid_session", "Invalid or expired session");
      return null;
    }

    if (config.requireAuthOnStreams) {
      const auth = await authenticateRequest(req);
      if (!auth.ok) {
        telemetry.recordAuthFailure();
        sendError(res, auth.status, auth.code, auth.message);
        return null;
      }
      if (record.userId !== auth.userId) {
        sendError(res, 403, "session_forbidden", "Session does not belong to this API key");
        return null;
      }
    }

    return { sessionId };
  };

  app.get("/mcp", async (req, res) => {
    if (config.startupMode === "registration-only") {
      sendError(
        res,
        503,
        "registration_only_mode",
        "MCP tool transport is disabled in registration-only startup mode",
      );
      return;
    }
    if (!statefulSessions) {
      sendError(
        res,
        409,
        "session_mode_stateless",
        "GET /mcp is unavailable when MCP_SESSION_MODE=stateless",
      );
      return;
    }
    const access = await validateStreamAccess(req, res);
    if (!access) return;
    const transport = transports.get(access.sessionId)!;
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    if (config.startupMode === "registration-only") {
      sendError(
        res,
        503,
        "registration_only_mode",
        "MCP tool transport is disabled in registration-only startup mode",
      );
      return;
    }
    if (!statefulSessions) {
      sendError(
        res,
        409,
        "session_mode_stateless",
        "DELETE /mcp is unavailable when MCP_SESSION_MODE=stateless",
      );
      return;
    }
    const access = await validateStreamAccess(req, res);
    if (!access) return;
    const transport = transports.get(access.sessionId)!;
    await transport.handleRequest(req, res);
    transports.delete(access.sessionId);
    sessions.delete(access.sessionId);
  });

  return {
    app,
    sessions,
    close: async () => {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
      }
      if (statefulSessions) {
        sessions.clear();
        for (const transport of transports.values()) {
          await transport.close().catch(() => {});
        }
        transports.clear();
      }
      await requestLimiter.close();
      await registerLimiter.close();
    },
  };
}

async function startStdio(config: ServerConfig): Promise<void> {
  if (config.arcagentApiKey) {
    try {
      const user = await validateApiKey(config.arcagentApiKey);
      if (!user) throw new Error("Invalid ARCAGENT_API_KEY");
      setStdioAuthUser(user, config.arcagentApiKey);
      console.error(`[MCP] Authenticated as ${user.name} (${user.email})`);
    } catch (err) {
      console.error(
        `[MCP] API key validation failed: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  }

  const server = createMcpServer({
    enableWorkspaceTools: true,
    enableRegistration: true,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Server running on stdio");
}

async function startHttp(config: ServerConfig): Promise<HttpServer> {
  const runtime = await createHttpRuntime(config);
  const server = createServer(runtime.app);
  await new Promise<void>((resolve) => {
    server.listen(config.mcpPort, resolve);
  });

  const closeServer = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await runtime.close();
  };

  process.once("SIGINT", () => void closeServer());
  process.once("SIGTERM", () => void closeServer());

  const localBase = `http://localhost:${config.mcpPort}`;
  const advertisedBase = config.publicBaseUrl || localBase;
  console.log(`[MCP] HTTP server listening on port ${config.mcpPort}`);
  console.log(`[MCP] Session mode: ${config.sessionMode}`);
  console.log(`[MCP] Register: POST ${advertisedBase}/api/mcp/register`);
  console.log(`[MCP] MCP endpoint: POST ${advertisedBase}/mcp`);
  return server;
}

export async function main(config = loadServerConfig()): Promise<void> {
  assertConfig(config);

  if (!config.workerSharedSecret) {
    console.warn("[MCP] WORKER_SHARED_SECRET not set — using scoped workspace tokens via Convex");
  }

  initConvexClient(config.convexUrl);
  if (config.workerSharedSecret) {
    initWorkerClient(config.workerSharedSecret);
  }

  if (config.transport === "stdio") {
    if (config.startupMode === "registration-only") {
      throw new Error("registration-only startup mode does not support stdio transport");
    }
    await startStdio(config);
  } else {
    await startHttp(config);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });
}
