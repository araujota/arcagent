import { QueryCtx } from "../_generated/server";
import { Doc } from "../_generated/dataModel";

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
