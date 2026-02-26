import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser } from "./__tests__/helpers";

describe("testBounties.createAndClaim", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.TEST_BOUNTY_REPOSITORY_URL = "https://github.com/araujota/arcagent";
    process.env.TEST_BOUNTY_DEFAULT_BRANCH = "main";
    process.env.TEST_BOUNTY_COMMIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";
  });

  afterEach(() => {
    delete process.env.TEST_BOUNTY_REPOSITORY_URL;
    delete process.env.TEST_BOUNTY_DEFAULT_BRANCH;
    delete process.env.TEST_BOUNTY_COMMIT_SHA;
  });

  it("creates full test bounty artifacts and claim", async () => {
    const t = convexTest(schema);

    const agentId = await t.run(async (ctx) => {
      return await seedUser(ctx, { role: "agent" });
    });

    const result = await t.action(internal.testBounties.createAndClaim, { agentId });

    expect(result.bountyId).toBeDefined();
    expect(result.claimId).toBeDefined();

    const state = await t.run(async (ctx) => {
      const bounty = await ctx.db.get(result.bountyId);
      const claim = await ctx.db.get(result.claimId);
      const suites = await ctx.db
        .query("testSuites")
        .withIndex("by_bountyId", (q: any) => q.eq("bountyId", result.bountyId))
        .collect();
      const generated = await ctx.db
        .query("generatedTests")
        .withIndex("by_bountyId", (q: any) => q.eq("bountyId", result.bountyId))
        .first();
      const repoConn = await ctx.db
        .query("repoConnections")
        .withIndex("by_bountyId", (q: any) => q.eq("bountyId", result.bountyId))
        .first();

      return { bounty, claim, suites, generated, repoConn };
    });

    expect(state.bounty?.isTestBounty).toBe(true);
    expect(state.bounty?.testBountyKind).toBe("agenthello_v1");
    expect(state.bounty?.status).toBe("in_progress");
    expect(state.claim?.status).toBe("active");
    expect(state.suites).toHaveLength(2);
    expect(state.generated?.status).toBe("published");
    expect(state.generated?.stepDefinitionsPublic).toContain("agenthellos.public.steps.js");
    expect(state.generated?.stepDefinitionsHidden).toContain("agenthellos.hidden.steps.js");
    expect(state.repoConn?.status).toBe("ready");
    expect(state.repoConn?.commitSha).toBe(process.env.TEST_BOUNTY_COMMIT_SHA);
  });
});
