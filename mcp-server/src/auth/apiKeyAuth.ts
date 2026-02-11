import { hashApiKey } from "../lib/crypto";
import { callConvex } from "../convex/client";
import { AuthenticatedUser } from "../lib/types";

interface CacheEntry {
  user: AuthenticatedUser;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000; // 60 seconds
const cache = new Map<string, CacheEntry>();

/**
 * Validate an API key and return the authenticated user.
 * Results are cached for 60 seconds.
 */
export async function validateApiKey(
  apiKey: string,
): Promise<AuthenticatedUser | null> {
  if (!apiKey.startsWith("arc_") || apiKey.length !== 36) {
    return null;
  }

  const keyHash = hashApiKey(apiKey);

  // Check cache
  const cached = cache.get(keyHash);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  // Validate against Convex
  const result = await callConvex<{
    valid: boolean;
    userId?: string;
    user?: { _id: string; name: string; email: string; role: string };
    scopes?: string[];
  }>("/api/mcp/auth/validate", { keyHash });

  if (!result.valid || !result.user || !result.userId || !result.scopes) {
    return null;
  }

  const user: AuthenticatedUser = {
    userId: result.userId,
    name: result.user.name,
    email: result.user.email,
    role: result.user.role,
    scopes: result.scopes,
  };

  // Cache the result
  cache.set(keyHash, {
    user,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return user;
}

/**
 * Extract API key from Authorization header.
 */
export function extractApiKey(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice("Bearer ".length);
}
