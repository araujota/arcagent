import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser, seedBounty, seedConversation } from "./__tests__/helpers";

describe("conversations.createInternal", () => {
  it("creates conversation with repo_indexing status and empty messages", async () => {
    const t = convexTest(schema);
    const bountyId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      return await seedBounty(ctx, creatorId);
    });

    const convId = await t.mutation(internal.conversations.createInternal, {
      bountyId,
    });

    const conv = await t.run(async (ctx) => ctx.db.get(convId));
    expect(conv).toBeDefined();
    expect(conv!.status).toBe("repo_indexing");
    expect(conv!.messages).toEqual([]);
  });

  it("creates autonomous conversation when flag set", async () => {
    const t = convexTest(schema);
    const bountyId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      return await seedBounty(ctx, creatorId);
    });

    const convId = await t.mutation(internal.conversations.createInternal, {
      bountyId,
      autonomous: true,
    });

    const conv = await t.run(async (ctx) => ctx.db.get(convId));
    expect(conv!.autonomous).toBe(true);
  });
});

describe("conversations.addMessage", () => {
  it("appends a message with timestamp to the messages array", async () => {
    const t = convexTest(schema);
    const convId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      return await seedConversation(ctx, bountyId);
    });

    await t.mutation(internal.conversations.addMessage, {
      conversationId: convId,
      role: "user",
      content: "Hello, I need help",
    });

    const conv = await t.run(async (ctx) => ctx.db.get(convId));
    expect(conv!.messages).toHaveLength(1);
    expect(conv!.messages[0].role).toBe("user");
    expect(conv!.messages[0].content).toBe("Hello, I need help");
    expect(conv!.messages[0].timestamp).toBeDefined();
  });

  it("accumulates multiple messages", async () => {
    const t = convexTest(schema);
    const convId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      return await seedConversation(ctx, bountyId);
    });

    await t.mutation(internal.conversations.addMessage, {
      conversationId: convId,
      role: "user",
      content: "First message",
    });
    await t.mutation(internal.conversations.addMessage, {
      conversationId: convId,
      role: "assistant",
      content: "Second message",
    });

    const conv = await t.run(async (ctx) => ctx.db.get(convId));
    expect(conv!.messages).toHaveLength(2);
    expect(conv!.messages[0].role).toBe("user");
    expect(conv!.messages[1].role).toBe("assistant");
  });
});

describe("conversations.updateStatus", () => {
  it("updates conversation status", async () => {
    const t = convexTest(schema);
    const convId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      return await seedConversation(ctx, bountyId);
    });

    await t.mutation(internal.conversations.updateStatus, {
      conversationId: convId,
      status: "generating_bdd",
    });

    const conv = await t.run(async (ctx) => ctx.db.get(convId));
    expect(conv!.status).toBe("generating_bdd");
  });
});

describe("conversations.getByBountyIdInternal", () => {
  it("returns latest conversation for a bounty", async () => {
    const t = convexTest(schema);
    const bountyId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      await seedConversation(ctx, bountyId, { status: "gathering" });
      return bountyId;
    });

    const conv = await t.query(internal.conversations.getByBountyIdInternal, { bountyId });
    expect(conv).toBeDefined();
    expect(conv!.status).toBe("gathering");
  });
});

describe("conversations.updateRepoContext", () => {
  it("stores repoContextSnapshot", async () => {
    const t = convexTest(schema);
    const convId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      return await seedConversation(ctx, bountyId);
    });

    await t.mutation(internal.conversations.updateRepoContext, {
      conversationId: convId,
      repoContextSnapshot: "src/\n  index.ts\n  utils.ts",
    });

    const conv = await t.run(async (ctx) => ctx.db.get(convId));
    expect(conv!.repoContextSnapshot).toBe("src/\n  index.ts\n  utils.ts");
  });
});
