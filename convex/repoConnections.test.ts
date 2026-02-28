import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser, seedBounty, seedRepoConnection } from "./__tests__/helpers";
import { detectProvider } from "./lib/repoProviders";

describe("repoConnections.createInternal", () => {
  it("creates a repo connection with pending status", async () => {
    const t = convexTest(schema);
    const bountyId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      return await seedBounty(ctx, creatorId);
    });

    const connId = await t.mutation(internal.repoConnections.createInternal, {
      bountyId,
      repositoryUrl: "https://github.com/test/repo",
      githubInstallationId: 12345,
      githubInstallationAccountLogin: "test-org",
    });

    const conn = await t.run(async (ctx) => ctx.db.get(connId));
    expect(conn).toBeDefined();
    expect(conn!.status).toBe("pending");
    expect(conn!.repositoryUrl).toBe("https://github.com/test/repo");
    expect(conn!.provider).toBe("github");
    expect(conn!.githubInstallationId).toBe(12345);
  });

  it("rejects GitHub repo connections without an installation id", async () => {
    const t = convexTest(schema);
    const bountyId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      return await seedBounty(ctx, creatorId);
    });

    await expect(
      t.mutation(internal.repoConnections.createInternal, {
        bountyId,
        repositoryUrl: "https://github.com/test/repo",
      }),
    ).rejects.toThrow(/GitHub App installation is required/);
  });

  it("detects GitLab provider from URL", async () => {
    const t = convexTest(schema);
    const bountyId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      return await seedBounty(ctx, creatorId);
    });

    const connId = await t.mutation(internal.repoConnections.createInternal, {
      bountyId,
      repositoryUrl: "https://gitlab.com/group/repo",
    });

    const conn = await t.run(async (ctx) => ctx.db.get(connId));
    expect(conn!.provider).toBe("gitlab");
  });
});

describe("repoConnections.getByBountyIdInternal", () => {
  it("returns connection for a bounty", async () => {
    const t = convexTest(schema);
    const bountyId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      await seedRepoConnection(ctx, bountyId, {
        repositoryUrl: "https://github.com/owner/myrepo",
      });
      return bountyId;
    });

    const conn = await t.query(internal.repoConnections.getByBountyIdInternal, {
      bountyId,
    });
    expect(conn).toBeDefined();
    expect(conn!.repositoryUrl).toBe("https://github.com/owner/myrepo");
  });

  it("returns null when no connection exists", async () => {
    const t = convexTest(schema);
    const bountyId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      return await seedBounty(ctx, creatorId);
    });

    const conn = await t.query(internal.repoConnections.getByBountyIdInternal, {
      bountyId,
    });
    expect(conn).toBeNull();
  });
});

describe("repoConnections.updateStatus", () => {
  it("updates connection status", async () => {
    const t = convexTest(schema);
    const connId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      return await seedRepoConnection(ctx, bountyId);
    });

    await t.mutation(internal.repoConnections.updateStatus, {
      repoConnectionId: connId,
      status: "ready",
    });

    const conn = await t.run(async (ctx) => ctx.db.get(connId));
    expect(conn!.status).toBe("ready");
  });

  it("stores errorMessage when provided", async () => {
    const t = convexTest(schema);
    const connId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      return await seedRepoConnection(ctx, bountyId);
    });

    await t.mutation(internal.repoConnections.updateStatus, {
      repoConnectionId: connId,
      status: "failed",
      errorMessage: "Clone failed: 404",
    });

    const conn = await t.run(async (ctx) => ctx.db.get(connId));
    expect(conn!.status).toBe("failed");
    expect(conn!.errorMessage).toBe("Clone failed: 404");
  });
});

describe("repoConnections.triggerReIndex", () => {
  it("updates commitSha and sets status to fetching", async () => {
    const t = convexTest(schema);
    const connId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      return await seedRepoConnection(ctx, bountyId, {
        status: "ready",
        commitSha: "old-sha",
      });
    });

    await t.mutation(internal.repoConnections.triggerReIndex, {
      repoConnectionId: connId,
      newCommitSha: "new-sha-abc",
    });

    const conn = await t.run(async (ctx) => ctx.db.get(connId));
    expect(conn!.commitSha).toBe("new-sha-abc");
    expect(conn!.status).toBe("fetching");
  });
});

describe("Repo Connection URL Validation", () => {
  it("detects valid GitHub HTTPS URLs", () => {
    expect(detectProvider("https://github.com/owner/repo")).toBe("github");
    expect(detectProvider("https://github.com/my-org/my-repo")).toBe("github");
    expect(detectProvider("https://github.com/user.name/repo.name")).toBe("github");
    expect(detectProvider("http://github.com/owner/repo")).toBe("github");
  });

  it("detects valid GitLab HTTPS URLs", () => {
    expect(detectProvider("https://gitlab.com/owner/repo")).toBe("gitlab");
    expect(detectProvider("https://gitlab.com/group/subgroup/repo")).toBe("gitlab");
  });

  it("detects valid Bitbucket HTTPS URLs", () => {
    expect(detectProvider("https://bitbucket.org/workspace/slug")).toBe("bitbucket");
  });

  it("detects SSH URLs", () => {
    expect(detectProvider("git@github.com:owner/repo.git")).toBe("github");
    expect(detectProvider("git@gitlab.com:owner/repo.git")).toBe("gitlab");
    expect(detectProvider("git@bitbucket.org:workspace/slug.git")).toBe("bitbucket");
  });

  it("rejects self-hosted URLs", () => {
    expect(detectProvider("https://git.example.com/owner/repo")).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(detectProvider("not-a-url")).toBeNull();
    expect(detectProvider("ftp://github.com/owner/repo")).toBeNull();
  });

  it("detects provider even for incomplete paths (parseUrl validates structure)", () => {
    // detectProvider only checks the domain — parseUrl throws for missing owner/repo
    expect(detectProvider("https://github.com/")).toBe("github");
    expect(detectProvider("https://github.com/owner")).toBe("github");
  });
});
