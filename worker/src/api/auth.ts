import { Request, Response, NextFunction } from "express";
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
 * Constant-time string comparison.  Uses Node's native crypto module when
 * available.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");

  // Node.js crypto.timingSafeEqual throws if lengths differ, so we guard
  // above.  Using a manual XOR as a portable fallback.
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i]! ^ bufB[i]!;
  }
  return result === 0;
}
