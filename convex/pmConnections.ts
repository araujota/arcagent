import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth } from "./lib/utils";

/**
 * Hash an API token with SHA-256 for storage.
 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const providerValidator = v.union(
  v.literal("jira"),
  v.literal("linear"),
  v.literal("asana"),
  v.literal("monday")
);

/**
 * Create a new PM tool connection.
 * Token is hashed before storage — the raw token is used immediately and never stored.
 */
export const create = mutation({
  args: {
    provider: providerValidator,
    displayName: v.string(),
    domain: v.optional(v.string()),
    email: v.optional(v.string()),
    apiToken: v.string(),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    // Validate provider-specific requirements
    if (args.provider === "jira") {
      if (!args.domain) throw new Error("Jira requires a domain (e.g., mycompany.atlassian.net)");
      if (!args.email) throw new Error("Jira requires an email for authentication");
    }

    const apiTokenHash = await hashToken(args.apiToken);
    const apiTokenPrefix = args.apiToken.slice(0, 8);

    return await ctx.db.insert("pmConnections", {
      userId: user._id,
      provider: args.provider,
      displayName: args.displayName,
      domain: args.domain,
      email: args.email,
      apiTokenHash,
      apiTokenPrefix,
      authMethod: "api_token",
      status: "active",
      createdAt: Date.now(),
    });
  },
});

/**
 * List the current user's PM connections.
 * Does not expose tokens.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];

    const connections = await ctx.db
      .query("pmConnections")
      .withIndex("by_userId_and_status", (q) =>
        q.eq("userId", user._id).eq("status", "active")
      )
      .collect();

    return connections.map((c) => ({
      _id: c._id,
      provider: c.provider,
      displayName: c.displayName,
      domain: c.domain,
      email: c.email,
      apiTokenPrefix: c.apiTokenPrefix,
      status: c.status,
      createdAt: c.createdAt,
    }));
  },
});

/**
 * Revoke a PM connection (soft delete).
 */
export const revoke = mutation({
  args: { connectionId: v.id("pmConnections") },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const conn = await ctx.db.get(args.connectionId);
    if (!conn) throw new Error("Connection not found");
    if (conn.userId !== user._id) throw new Error("Unauthorized");

    await ctx.db.patch(args.connectionId, { status: "revoked" });
  },
});

/**
 * Internal query to get connection with token hash (for internal actions).
 */
export const getByIdInternal = internalQuery({
  args: { connectionId: v.id("pmConnections") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.connectionId);
  },
});

// NOTE: testConnection was removed because tokens are hashed at storage time
// and cannot be reversed for API validation. Real-time connection testing
// requires encrypted (not hashed) token storage, which is a planned future feature.
// For now, token validity is verified implicitly when the connection is used.
