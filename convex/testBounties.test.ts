import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser } from "./__tests__/helpers";

describe("testBounties.createAndClaim", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    process.env.TEST_BOUNTY_REPOSITORY_URL = "https://github.com/araujota/arcagent";
    process.env.TEST_BOUNTY_DEFAULT_BRANCH = "main";
    process.env.TEST_BOUNTY_COMMIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";
    delete process.env.GITHUB_API_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TEST_BOUNTY_REPOSITORY_URL;
    delete process.env.TEST_BOUNTY_DEFAULT_BRANCH;
    delete process.env.TEST_BOUNTY_COMMIT_SHA;
    delete process.env.GITHUB_API_TOKEN;
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

  it("resolves commit SHA via authenticated GitHub API when TEST_BOUNTY_COMMIT_SHA is unset", async () => {
    const t = convexTest(schema);
    const resolvedSha = "1234567890abcdef1234567890abcdef12345678";
    delete process.env.TEST_BOUNTY_COMMIT_SHA;
    process.env.GITHUB_API_TOKEN = "ghp_test_token";

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ sha: resolvedSha }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const agentId = await t.run(async (ctx) => {
      return await seedUser(ctx, { role: "agent" });
    });

    const result = await t.action(internal.testBounties.createAndClaim, { agentId });
    const repoConn = await t.run(async (ctx) => {
      return await ctx.db
        .query("repoConnections")
        .withIndex("by_bountyId", (q: any) => q.eq("bountyId", result.bountyId))
        .first();
    });

    expect(repoConn?.commitSha).toBe(resolvedSha);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/repos/araujota/arcagent/commits/main"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": "arcagent",
          Authorization: "Bearer ghp_test_token",
        }),
      }),
    );
  });

  it("returns actionable 403 diagnostics for commit resolution failures", async () => {
    const t = convexTest(schema);
    delete process.env.TEST_BOUNTY_COMMIT_SHA;
    process.env.GITHUB_API_TOKEN = "ghp_test_token";

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1893456000",
          },
        }),
      ),
    );

    const agentId = await t.run(async (ctx) => {
      return await seedUser(ctx, { role: "agent" });
    });

    await expect(
      t.action(internal.testBounties.createAndClaim, { agentId }),
    ).rejects.toThrow(/rateLimitRemaining=0.*TEST_BOUNTY_COMMIT_SHA/);
  });
});
