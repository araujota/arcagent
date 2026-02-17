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
/** Structured validation error for API key format issues */
export class ApiKeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyFormatError";
  }
}

export async function validateApiKey(
  apiKey: string,
): Promise<AuthenticatedUser | null> {
  if (!apiKey.startsWith("arc_")) {
    throw new ApiKeyFormatError("API key must start with 'arc_'");
  }
  if (apiKey.length < 36 || apiKey.length > 52) {
    throw new ApiKeyFormatError(
      `API key must be between 36 and 52 characters (got ${apiKey.length})`
    );
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
    throw new ApiKeyFormatError(
      "API key not found — it may have been revoked or expired"
    );
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
