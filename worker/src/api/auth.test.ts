import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { authMiddleware } from "./auth";

function mintScopedToken(payload: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

describe("authMiddleware", () => {
  beforeEach(() => {
    process.env.WORKER_SHARED_SECRET = "worker-shared-secret";
    delete process.env.WORKER_TOKEN_SIGNING_SECRET;
  });

  it("accepts legacy WORKER_SHARED_SECRET bearer token", () => {
    const req = {
      headers: { authorization: "Bearer worker-shared-secret" },
      path: "/workspace/exec",
      body: { workspaceId: "ws_123" },
      ip: "127.0.0.1",
    } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("accepts valid scoped workspace token", () => {
    process.env.WORKER_TOKEN_SIGNING_SECRET = "signing-secret";
    const now = Math.floor(Date.now() / 1000);
    const token = mintScopedToken(
      {
        iss: "arcagent-convex",
        aud: "arcagent-worker-workspace",
        routePath: "/api/workspace/exec",
        workspaceId: "ws_123",
        iat: now,
        nbf: now - 2,
        exp: now + 60,
      },
      "signing-secret",
    );

    const req = {
      headers: { authorization: `Bearer ${token}` },
      path: "/workspace/exec",
      body: { workspaceId: "ws_123" },
      ip: "127.0.0.1",
    } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
