import { describe, expect, it } from "vitest";
import { assertConfig, loadServerConfig } from "./config";

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
});
