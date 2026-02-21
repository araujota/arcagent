import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../schema";
import { internal } from "../_generated/api";
import { seedUser, seedBounty, seedSubmission, seedVerification } from "../__tests__/helpers";

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 202,
    json: async () => ({ jobId: "worker-uuid-123", status: "queued" }),
    text: async () => "OK",
  });
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  process.env.WORKER_API_URL = "http://localhost:3001";
  process.env.WORKER_SHARED_SECRET = "test-secret";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WORKER_API_URL;
  delete process.env.WORKER_SHARED_SECRET;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchVerification", () => {
  it("sends correct field names (repoUrl, commitSha) — not the old names", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, {
        status: "pending",
        repositoryUrl: "https://github.com/test/repo",
        commitHash: "abc1234",
      });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "pending",
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId };
    });

    await t.action(internal.pipelines.dispatchVerification.dispatchVerification, {
      verificationId: ids.verificationId,
      submissionId: ids.submissionId,
      bountyId: ids.bountyId,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);

    // Should use new field names
    expect(body.repoUrl).toBe("https://github.com/test/repo");
    expect(body.commitSha).toBe("abc1234");
    // Old field names should NOT be present
    expect(body.repositoryUrl).toBeUndefined();
    expect(body.commitHash).toBeUndefined();
  });

  it("sends jobHmac in dispatch body", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "pending" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "pending",
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId };
    });

    await t.action(internal.pipelines.dispatchVerification.dispatchVerification, {
      verificationId: ids.verificationId,
      submissionId: ids.submissionId,
      bountyId: ids.bountyId,
    });

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.jobHmac).toBeDefined();
    expect(typeof body.jobHmac).toBe("string");
    expect(body.jobHmac.length).toBe(64); // SHA-256 hex
  });

  it("marks verification and submission as failed when env vars missing", async () => {
    delete process.env.WORKER_API_URL;
    delete process.env.WORKER_SHARED_SECRET;

    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "pending" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "pending",
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId };
    });

    await t.action(internal.pipelines.dispatchVerification.dispatchVerification, {
      verificationId: ids.verificationId,
      submissionId: ids.submissionId,
      bountyId: ids.bountyId,
    });

    const verification = await t.run(async (ctx) => ctx.db.get(ids.verificationId));
    expect(verification!.status).toBe("failed");
    expect(verification!.errorLog).toContain("WORKER_API_URL");

    const submission = await t.run(async (ctx) => ctx.db.get(ids.submissionId));
    expect(submission!.status).toBe("failed");
  });

  it("marks verification and submission as failed on worker HTTP error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "Server exploded",
    });

    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "pending" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "pending",
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId };
    });

    await t.action(internal.pipelines.dispatchVerification.dispatchVerification, {
      verificationId: ids.verificationId,
      submissionId: ids.submissionId,
      bountyId: ids.bountyId,
    });

    const verification = await t.run(async (ctx) => ctx.db.get(ids.verificationId));
    expect(verification!.status).toBe("failed");
    expect(verification!.errorLog).toContain("500");

    const submission = await t.run(async (ctx) => ctx.db.get(ids.submissionId));
    expect(submission!.status).toBe("failed");
  });

  it("creates verificationJob record before dispatching", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "pending" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "pending",
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId };
    });

    await t.action(internal.pipelines.dispatchVerification.dispatchVerification, {
      verificationId: ids.verificationId,
      submissionId: ids.submissionId,
      bountyId: ids.bountyId,
    });

    // Check that a verificationJob was created
    const jobs = await t.run(async (ctx) => {
      return await ctx.db
        .query("verificationJobs")
        .withIndex("by_verificationId", (q: any) =>
          q.eq("verificationId", ids.verificationId)
        )
        .collect();
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("queued");
  });

  it("saves worker's jobId as workerJobId via correct response field", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ jobId: "worker-uuid-456", status: "queued" }),
      text: async () => "OK",
    });

    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "pending" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "pending",
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId };
    });

    await t.action(internal.pipelines.dispatchVerification.dispatchVerification, {
      verificationId: ids.verificationId,
      submissionId: ids.submissionId,
      bountyId: ids.bountyId,
    });

    const jobs = await t.run(async (ctx) => {
      return await ctx.db
        .query("verificationJobs")
        .withIndex("by_verificationId", (q: any) =>
          q.eq("verificationId", ids.verificationId)
        )
        .collect();
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].workerJobId).toBe("worker-uuid-456");
  });
});

describe("dispatchVerificationFromDiff", () => {
  it("sends correct field names (repoUrl, commitSha) for diff-based dispatch", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "pending" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "pending",
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId };
    });

    await t.action(internal.pipelines.dispatchVerification.dispatchVerificationFromDiff, {
      verificationId: ids.verificationId,
      submissionId: ids.submissionId,
      bountyId: ids.bountyId,
      baseRepoUrl: "https://github.com/test/base-repo",
      baseCommitSha: "base123",
      diffPatch: "diff --git a/file.ts b/file.ts\n...",
      sourceWorkspaceId: "ws-1",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.repoUrl).toBe("https://github.com/test/base-repo");
    expect(body.commitSha).toBe("base123");
    expect(body.repositoryUrl).toBeUndefined();
    expect(body.commitHash).toBeUndefined();
    expect(body.diffPatch).toBe("diff --git a/file.ts b/file.ts\n...");
    expect(body.jobHmac).toBeDefined();
  });
});
