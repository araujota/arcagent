import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { generateKeyPairSync } from "node:crypto";
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
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();

    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/repos/araujota/arcagent/installation")) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 4242, account: { login: "araujota" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.includes("/app/installations/4242/access_tokens")) {
        return Promise.resolve(
          new Response(JSON.stringify({ token: "ghs_install_token" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("Not mocked", { status: 404 }));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TEST_BOUNTY_REPOSITORY_URL;
    delete process.env.TEST_BOUNTY_DEFAULT_BRANCH;
    delete process.env.TEST_BOUNTY_COMMIT_SHA;
    delete process.env.GITHUB_API_TOKEN;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
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
    expect(state.generated?.gherkinPublic).toContain("And the page stores hello entries in local client code");
    expect(state.generated?.gherkinHidden).toContain("And the agenthellos page does not import convex client APIs");
    expect(state.generated?.gherkinHidden).toContain("And the agenthellos page does not read agent hellos from convex");
    const hiddenStepDefs = JSON.parse(state.generated?.stepDefinitionsHidden ?? "[]") as Array<{ content?: string }>;
    expect(hiddenStepDefs[0]?.content).toContain("Then(/the sidebar includes a navigation link to \\/agenthellos/");
    expect(hiddenStepDefs[0]?.content).toContain("Given('the agenthellos route exists'");
    expect(hiddenStepDefs[0]?.content).toContain("Then('the agenthellos page does not import convex client APIs'");
    expect(hiddenStepDefs[0]?.content).toContain("Then('the agenthellos page does not read agent hellos from convex'");
    expect(hiddenStepDefs[0]?.content).toContain("useProductAnalytics");
    expect(state.repoConn?.status).toBe("ready");
    expect(state.repoConn?.commitSha).toBe(process.env.TEST_BOUNTY_COMMIT_SHA);
  });

  it("resolves commit SHA via authenticated GitHub API when TEST_BOUNTY_COMMIT_SHA is unset", async () => {
    const t = convexTest(schema);
    const resolvedSha = "1234567890abcdef1234567890abcdef12345678";
    delete process.env.TEST_BOUNTY_COMMIT_SHA;
    process.env.GITHUB_API_TOKEN = "ghp_unused_when_app_token_available";

    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/repos/araujota/arcagent/installation")) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 4242, account: { login: "araujota" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.includes("/app/installations/4242/access_tokens")) {
        return Promise.resolve(
          new Response(JSON.stringify({ token: "ghs_install_token" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.includes("/repos/araujota/arcagent/commits/main")) {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer ghs_install_token",
          "User-Agent": "arcagent",
        });
        return Promise.resolve(
          new Response(JSON.stringify({ sha: resolvedSha }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("Not mocked", { status: 404 }));
    });

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
          Authorization: "Bearer ghs_install_token",
        }),
      }),
    );
  });

  it("returns actionable 403 diagnostics for commit resolution failures", async () => {
    const t = convexTest(schema);
    delete process.env.TEST_BOUNTY_COMMIT_SHA;
    process.env.GITHUB_API_TOKEN = "ghp_unused_when_app_token_available";

    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/repos/araujota/arcagent/installation")) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 4242, account: { login: "araujota" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.includes("/app/installations/4242/access_tokens")) {
        return Promise.resolve(
          new Response(JSON.stringify({ token: "ghs_install_token" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.includes("/repos/araujota/arcagent/commits/main")) {
        return Promise.resolve(
          new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1893456000",
            },
          }),
        );
      }
      return Promise.resolve(new Response("Not mocked", { status: 404 }));
    });

    const agentId = await t.run(async (ctx) => {
      return await seedUser(ctx, { role: "agent" });
    });

    await expect(
      t.action(internal.testBounties.createAndClaim, { agentId }),
    ).rejects.toThrow(/rateLimitRemaining=0.*TEST_BOUNTY_COMMIT_SHA/);
  });

  it("fails fast when the app is not installed on the test bounty repository", async () => {
    const t = convexTest(schema);
    mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const agentId = await t.run(async (ctx) => {
      return await seedUser(ctx, { role: "agent" });
    });

    await expect(
      t.action(internal.testBounties.createAndClaim, { agentId }),
    ).rejects.toThrow(/GitHub App installation is required/);
  });
});
