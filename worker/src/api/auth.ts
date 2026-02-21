import { Request, Response, NextFunction } from "express";
import { timingSafeEqual as cryptoTimingSafeEqual, createHmac } from "node:crypto";
import { logger } from "../index";

/**
 * Shared-secret authentication middleware.
 *
 * Expects an `Authorization: Bearer <token>` header whose value matches the
 * `WORKER_SHARED_SECRET` environment variable.  If the variable is unset the
 * server refuses to start (caught in index.ts) – but we also reject all
 * requests as a defence-in-depth measure.
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

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(token, secret)) {
    logger.warn("Unauthorised request from %s", req.ip);
    res.status(403).json({ error: "Forbidden" });
    return;
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
