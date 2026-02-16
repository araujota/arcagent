/**
 * SECURITY (C1): AsyncLocalStorage-based context that carries the
 * authenticated userId from the HTTP auth layer into MCP tool handlers.
 *
 * This prevents agent impersonation — tools read the authenticated user
 * from context instead of accepting agentId/userId as parameters.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { AuthenticatedUser } from "./types";

export interface AuthContext {
  user: AuthenticatedUser;
}

const authStore = new AsyncLocalStorage<AuthContext>();

/**
 * Run a callback within an authenticated context.
 * Used by the HTTP transport handler after validating the API key.
 */
export function runWithAuth<T>(user: AuthenticatedUser, fn: () => T): T {
  return authStore.run({ user }, fn);
}

/**
 * Get the authenticated user from the current context.
 * Returns undefined if no auth context is set (e.g., stdio transport).
 */
export function getAuthUser(): AuthenticatedUser | undefined {
  return authStore.getStore()?.user;
}

/**
 * Get the authenticated user or throw if not available.
 * For use in tools that require authentication.
 */
export function requireAuthUser(): AuthenticatedUser {
  const user = getAuthUser();
  if (!user) {
    throw new Error(
      "Authentication required. No auth context available — " +
      "ensure you are using the HTTP transport with a valid API key."
    );
  }
  return user;
}

/**
 * SECURITY (H4): Check that the authenticated user has the required scope.
 * Throws if the user's API key doesn't include the specified scope.
 */
export function requireScope(scope: string): void {
  const user = getAuthUser();
  if (!user) {
    // stdio transport — no scopes to check
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[scope] Running without auth — "${scope}" scope not enforced`);
    }
    return;
  }
  if (!user.scopes.includes(scope)) {
    throw new Error(
      `Insufficient permissions: this operation requires the "${scope}" scope. Generate a new API key with this scope to proceed.`
    );
  }
}
