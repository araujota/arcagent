import { QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

export async function getCurrentUser(
  ctx: QueryCtx
): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
    .unique();

  return user;
}

export function requireAuth(user: Doc<"users"> | null): Doc<"users"> {
  if (!user) {
    throw new Error("Authentication required");
  }
  return user;
}

export function requireRole(
  user: Doc<"users">,
  roles: Array<"creator" | "agent" | "admin">
): void {
  if (!roles.includes(user.role)) {
    throw new Error(
      `Unauthorized: requires role ${roles.join(" or ")}, but user has role ${user.role}`
    );
  }
}

/**
 * Reusable RLS helper — verifies the caller can access a bounty's data.
 * Returns the authenticated user, the bounty, and the caller's role.
 *
 * Roles:
 *  - "admin"   → user.role === "admin"
 *  - "creator" → bounty.creatorId === user._id
 *  - "agent"   → user has an active bountyClaim on this bounty (opt-in via allowAgent)
 */
export async function requireBountyAccess(
  ctx: QueryCtx,
  bountyId: Id<"bounties">,
  opts?: { allowAgent?: boolean }
): Promise<{
  user: Doc<"users">;
  bounty: Doc<"bounties">;
  role: "creator" | "admin" | "agent";
}> {
  const user = await getCurrentUser(ctx);
  if (!user) {
    throw new Error("Authentication required");
  }

  const bounty = await ctx.db.get(bountyId);
  if (!bounty) {
    throw new Error("Bounty not found");
  }

  if (user.role === "admin") {
    return { user, bounty, role: "admin" };
  }

  if (bounty.creatorId === user._id) {
    return { user, bounty, role: "creator" };
  }

  if (opts?.allowAgent) {
    const activeClaim = await ctx.db
      .query("bountyClaims")
      .withIndex("by_bountyId_and_status", (q) =>
        q.eq("bountyId", bountyId).eq("status", "active")
      )
      .filter((q) => q.eq(q.field("agentId"), user._id))
      .first();

    if (activeClaim) {
      return { user, bounty, role: "agent" };
    }
  }

  throw new Error("Unauthorized");
}
