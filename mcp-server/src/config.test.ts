import { describe, expect, it } from "vitest";
import { assertConfig, loadServerConfig } from "./config";

describe("config startup modes", () => {
  it("allows registration-only mode without ARCAGENT_API_KEY", () => {
    const cfg = loadServerConfig({
      MCP_STARTUP_MODE: "registration-only",
      MCP_TRANSPORT: "http",
      MCP_SHARED_SECRET: "mcp_secret",
      CLERK_SECRET_KEY: "clerk_secret",
    });
    expect(() => assertConfig(cfg)).not.toThrow();
  });

  it("rejects registration-only mode without MCP_SHARED_SECRET", () => {
    const cfg = loadServerConfig({
      MCP_STARTUP_MODE: "registration-only",
      MCP_TRANSPORT: "http",
      CLERK_SECRET_KEY: "clerk_secret",
    });
    expect(() => assertConfig(cfg)).toThrow("requires MCP_SHARED_SECRET");
  });

  it("rejects registration-only mode with stdio transport", () => {
    const cfg = loadServerConfig({
      MCP_STARTUP_MODE: "registration-only",
      MCP_TRANSPORT: "stdio",
      MCP_SHARED_SECRET: "mcp_secret",
      CLERK_SECRET_KEY: "clerk_secret",
    });
    expect(() => assertConfig(cfg)).toThrow("requires MCP_TRANSPORT=http");
  });
});
