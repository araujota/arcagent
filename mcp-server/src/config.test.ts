import { describe, expect, it } from "vitest";
import { assertConfig, isHostedRuntime, loadServerConfig } from "./config";

describe("config startup modes", () => {
  it("defaults CONVEX_URL to production deployment", () => {
    const cfg = loadServerConfig({});
    expect(cfg.convexUrl).toBe("https://acoustic-starfish-282.convex.site");
  });

  it("normalizes .convex.cloud to .convex.site for HTTP actions", () => {
    const cfg = loadServerConfig({
      CONVEX_URL: "https://acoustic-starfish-282.convex.cloud",
    });
    expect(cfg.convexUrl).toBe("https://acoustic-starfish-282.convex.site");
  });

  it("allows registration-only mode without credentials", () => {
    const cfg = loadServerConfig({
      MCP_STARTUP_MODE: "registration-only",
      MCP_TRANSPORT: "http",
    });
    expect(() => assertConfig(cfg)).not.toThrow();
  });

  it("allows full mode without credentials (registration only path)", () => {
    const cfg = loadServerConfig({});
    expect(() => assertConfig(cfg)).not.toThrow();
  });

  it("rejects registration-only mode with stdio transport", () => {
    const cfg = loadServerConfig({
      MCP_STARTUP_MODE: "registration-only",
      MCP_TRANSPORT: "stdio",
    });
    expect(() => assertConfig(cfg)).toThrow("requires MCP_TRANSPORT=http");
  });

  it("requires redis rate limiting in hosted mode", () => {
    const cfg = loadServerConfig({
      MCP_TRANSPORT: "http",
      MCP_PUBLIC_BASE_URL: "https://mcp.arcagent.dev",
      MCP_REQUIRE_HTTPS: "true",
      RATE_LIMIT_STORE: "memory",
    });
    expect(isHostedRuntime(cfg)).toBe(true);
    expect(() => assertConfig(cfg)).toThrow("Hosted HTTP runtime requires RATE_LIMIT_STORE=redis");
  });

  it("rejects non-https public base URLs", () => {
    const cfg = loadServerConfig({
      MCP_TRANSPORT: "http",
      MCP_PUBLIC_BASE_URL: "http://mcp.arcagent.dev",
      RATE_LIMIT_STORE: "redis",
      RATE_LIMIT_REDIS_URL: "redis://localhost:6379",
    });
    expect(() => assertConfig(cfg)).toThrow("MCP_PUBLIC_BASE_URL must use https://");
  });

  it("requires redis URL when redis limiter is enabled", () => {
    const cfg = loadServerConfig({
      MCP_TRANSPORT: "http",
      RATE_LIMIT_STORE: "redis",
    });
    expect(() => assertConfig(cfg)).toThrow("requires RATE_LIMIT_REDIS_URL");
  });

  it("accepts hosted configuration with redis and https", () => {
    const cfg = loadServerConfig({
      MCP_TRANSPORT: "http",
      MCP_PUBLIC_BASE_URL: "https://mcp.arcagent.dev/",
      RATE_LIMIT_STORE: "redis",
      RATE_LIMIT_REDIS_URL: "redis://localhost:6379",
      MCP_REQUIRE_HTTPS: "true",
    });
    expect(cfg.publicBaseUrl).toBe("https://mcp.arcagent.dev");
    expect(cfg.allowedHosts).toEqual(["mcp.arcagent.dev"]);
    expect(() => assertConfig(cfg)).not.toThrow();
  });

  it("requires audit token when convex audit logs are enabled", () => {
    const cfg = loadServerConfig({
      MCP_ENABLE_CONVEX_AUDIT_LOGS: "true",
    });
    expect(() => assertConfig(cfg)).toThrow("requires MCP_AUDIT_LOG_TOKEN");
  });

  it("normalizes worker proxy settings", () => {
    const cfg = loadServerConfig({
      MCP_INTERNAL_WORKER_BASE_URL: "http://internal-worker.local:3001/",
      MCP_WORKER_PROXY_PATH_PREFIX: "worker-gateway/",
    });
    expect(cfg.internalWorkerBaseUrl).toBe("http://internal-worker.local:3001");
    expect(cfg.workerProxyPathPrefix).toBe("/worker-gateway");
  });
});
