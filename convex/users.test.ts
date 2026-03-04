import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser } from "./__tests__/helpers";

describe("upsertFromClerk", () => {
  it("creates new user with role 'creator'", async () => {
    const t = convexTest(schema);
    const userId = await t.mutation(internal.users.upsertFromClerk, {
      clerkId: "clerk_new",
      name: "Alice",
      email: "alice@test.com",
    });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user).toBeDefined();
    expect(user!.role).toBe("creator");
    expect(user!.name).toBe("Alice");
    expect(user!.email).toBe("alice@test.com");
  });

  it("updates existing user (same clerkId) -- name/email/avatar updated", async () => {
    const t = convexTest(schema);
    const userId = await t.mutation(internal.users.upsertFromClerk, {
      clerkId: "clerk_update",
      name: "Alice",
      email: "alice@test.com",
    });

    const updatedId = await t.mutation(internal.users.upsertFromClerk, {
      clerkId: "clerk_update",
      name: "Alice Updated",
      email: "alice-new@test.com",
      avatarUrl: "https://avatar.url/alice.png",
    });

    expect(updatedId).toEqual(userId);
    const user = await t.run(async (ctx) => ctx.db.get(updatedId));
    expect(user!.name).toBe("Alice Updated");
    expect(user!.email).toBe("alice-new@test.com");
    expect(user!.avatarUrl).toBe("https://avatar.url/alice.png");
  });

  it("grandfathers existing user: sets onboardingComplete=true, isTechnical=false", async () => {
    const t = convexTest(schema);
    // First upsert: creates user without onboardingComplete
    const userId = await t.mutation(internal.users.upsertFromClerk, {
      clerkId: "clerk_grandfather",
      name: "Bob",
      email: "bob@test.com",
    });

    // Second upsert: should grandfather since onboardingComplete is undefined
    await t.mutation(internal.users.upsertFromClerk, {
      clerkId: "clerk_grandfather",
      name: "Bob",
      email: "bob@test.com",
    });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.onboardingComplete).toBe(true);
    expect(user!.isTechnical).toBe(false);
  });

  it("does NOT re-grandfather when onboardingComplete already set", async () => {
    const t = convexTest(schema);
    // Create user and manually set onboarding
    const userId = await t.run(async (ctx) => {
      return await seedUser(ctx, {
        clerkId: "clerk_no_regrandfather",
        onboardingComplete: true,
        isTechnical: true,
      });
    });

    await t.mutation(internal.users.upsertFromClerk, {
      clerkId: "clerk_no_regrandfather",
      name: "Carol Updated",
      email: "carol@test.com",
    });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.isTechnical).toBe(true); // Not overwritten to false
  });

  it("updates githubUsername when provided", async () => {
    const t = convexTest(schema);
    const userId = await t.mutation(internal.users.upsertFromClerk, {
      clerkId: "clerk_github",
      name: "Dave",
      email: "dave@test.com",
      githubUsername: "davecoder",
    });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.githubUsername).toBe("davecoder");
  });
});

describe("deleteFromClerk", () => {
  it("deletes existing user", async () => {
    const t = convexTest(schema);
    const userId = await t.mutation(internal.users.upsertFromClerk, {
      clerkId: "clerk_delete",
      name: "Eve",
      email: "eve@test.com",
    });

    await t.mutation(internal.users.deleteFromClerk, { clerkId: "clerk_delete" });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user).toBeNull();
  });

  it("no-op for nonexistent clerkId (no throw)", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.users.deleteFromClerk, { clerkId: "clerk_nonexistent" });
    const user = await t.query(internal.users.getByClerkIdInternal, {
      clerkId: "clerk_nonexistent",
    });
    expect(user).toBeNull();
  });
});

describe("createApiAgent", () => {
  it("creates agent user with role 'agent', isApiAgent: true", async () => {
    const t = convexTest(schema);
    const userId = await t.mutation(internal.users.createApiAgent, {
      name: "AgentBot",
      email: "agent@test.com",
      clerkId: "clerk_agent",
    });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.role).toBe("agent");
    expect(user!.isApiAgent).toBe(true);
  });

  it("rejects duplicate email -> 'Email already registered'", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await seedUser(ctx, { email: "taken@test.com" });
    });

    await expect(
      t.mutation(internal.users.createApiAgent, {
        name: "Agent2",
        email: "taken@test.com",
        clerkId: "clerk_agent2",
      }),
    ).rejects.toThrow("Email already registered");
  });
});
