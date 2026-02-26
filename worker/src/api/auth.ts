import { Request, Response, NextFunction } from "express";
import { timingSafeEqual as cryptoTimingSafeEqual, createHmac } from "node:crypto";
import { logger } from "../index";

const WORKSPACE_AGENT_TOKEN_AUDIENCE = "arcagent-worker-workspace";
const WORKSPACE_AGENT_TOKEN_ISSUER = "arcagent-convex";

const ALLOWED_WORKSPACE_ROUTE_PATHS = new Set<string>([
  "/api/workspace/exec",
  "/api/workspace/read-file",
  "/api/workspace/write-file",
  "/api/workspace/diff",
  "/api/workspace/status",
  "/api/workspace/extend-ttl",
  "/api/workspace/batch-read",
  "/api/workspace/batch-write",
  "/api/workspace/search",
  "/api/workspace/list-files",
  "/api/workspace/exec-stream",
  "/api/workspace/exec-output",
  "/api/workspace/edit-file",
  "/api/workspace/glob",
  "/api/workspace/grep",
  "/api/workspace/session-exec",
]);

interface WorkspaceAgentTokenPayload {
  iss: string;
  aud: string;
  routePath: string;
  workspaceId: string;
  exp: number;
  nbf?: number;
}

function decodeBase64Url(segment: string): string {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf-8");
}

function verifyWorkspaceAgentToken(
  token: string,
  requestPath: string,
  workspaceId: unknown,
  signingSecret: string,
): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let payload: WorkspaceAgentTokenPayload;
  try {
    payload = JSON.parse(decodeBase64Url(encodedPayload)) as WorkspaceAgentTokenPayload;
  } catch {
    return false;
  }

  const routePath = `/api${requestPath}`;
  if (!ALLOWED_WORKSPACE_ROUTE_PATHS.has(routePath)) return false;
  if (payload.iss !== WORKSPACE_AGENT_TOKEN_ISSUER) return false;
  if (payload.aud !== WORKSPACE_AGENT_TOKEN_AUDIENCE) return false;
  if (payload.routePath !== routePath) return false;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return false;
  if (payload.workspaceId !== workspaceId) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.nbf && nowSeconds < payload.nbf) return false;
  if (nowSeconds >= payload.exp) return false;

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = createHmac("sha256", signingSecret)
    .update(signingInput)
    .digest("base64url");

  return timingSafeEqual(encodedSignature, expectedSignature);
}

/**
 * Worker authentication middleware.
 *
 * Accepts either:
 * 1. Service token: Authorization Bearer WORKER_SHARED_SECRET
 * 2. Scoped short-lived token minted by Convex for workspace routes
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = process.env.WORKER_SHARED_SECRET;

  if (!secret) {
    logger.error(
      "WORKER_SHARED_SECRET is not configured – rejecting request",
    );
    res.status(503).json({ error: "Service misconfigured" });
    return;
  }

  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }

  const token = header.slice("Bearer ".length);

  // Legacy service-to-service mode
  if (!timingSafeEqual(token, secret)) {
    const signingSecret = process.env.WORKER_TOKEN_SIGNING_SECRET ?? secret;
    const workspaceId = (req.body as { workspaceId?: unknown } | undefined)?.workspaceId;
    const validScopedToken = verifyWorkspaceAgentToken(
      token,
      req.path,
      workspaceId,
      signingSecret,
    );
    if (!validScopedToken) {
      logger.warn("Unauthorised request from %s", req.ip);
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }

  next();
}

/**
 * Constant-time string comparison that does not leak input lengths.
 *
 * HMAC both inputs with a fixed key so they always produce equal-length
 * digests, then use Node's native crypto.timingSafeEqual on the digests.
 * This avoids the classic timing side-channel of early-returning on length
 * mismatch.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const hmacA = createHmac("sha256", "constant-time-compare").update(a).digest();
  const hmacB = createHmac("sha256", "constant-time-compare").update(b).digest();
  return cryptoTimingSafeEqual(hmacA, hmacB);
}
