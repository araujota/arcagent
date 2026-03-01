import { convexTest } from "convex-test";
import { describe, it, expect, vi, afterEach } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser, seedBounty, seedSubmission, seedVerification, seedClaim } from "./__tests__/helpers";

describe("timeoutStale", () => {
  it("running verification past timeout+grace is marked as failed", async () => {
    const t = convexTest(schema);
    const { verificationId, submissionId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, {
        status: "running",
      });
      // Started 200s ago with a 60s timeout
      // elapsed (200s) > timeout (60s) + grace (60s) = 120s
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "running",
        startedAt: Date.now() - 200_000,
        timeoutSeconds: 60,
      });
      return { verificationId, submissionId };
    });

    await t.mutation(internal.verifications.timeoutStale, {});

    const verification = await t.run(async (ctx) => ctx.db.get(verificationId));
    expect(verification!.status).toBe("failed");
    expect(verification!.errorLog).toContain("timed out");
    expect(verification!.completedAt).toBeDefined();

    const submission = await t.run(async (ctx) => ctx.db.get(submissionId));
    expect(submission!.status).toBe("failed");
  });

  it("running verification within timeout is not affected", async () => {
    const t = convexTest(schema);
    const { verificationId, submissionId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, {
        status: "running",
      });
      // Started 30s ago with a 60s timeout
      // elapsed (30s) < timeout (60s) + grace (60s) = 120s
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "running",
        startedAt: Date.now() - 30_000,
        timeoutSeconds: 60,
      });
      return { verificationId, submissionId };
    });

    await t.mutation(internal.verifications.timeoutStale, {});

    const verification = await t.run(async (ctx) => ctx.db.get(verificationId));
    expect(verification!.status).toBe("running");
    expect(verification!.errorLog).toBeUndefined();

    const submission = await t.run(async (ctx) => ctx.db.get(submissionId));
    expect(submission!.status).toBe("running");
  });

  it("pending verification stuck >10min is marked as failed", async () => {
    // NOTE: The pending timeout check relies on v._creationTime which is set
    // automatically by Convex. In convex-test, _creationTime is set to
    // approximately Date.now() at insertion time. To test this we insert the
    // record and then mock Date.now() to be 11 minutes in the future.
    const t = convexTest(schema);
    const { verificationId, submissionId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, {
        status: "pending",
      });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "pending",
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId };
    });

    // Advance time by 11 minutes so _creationTime is >10 min old
    const originalDateNow = Date.now;
    const futureTime = Date.now() + 11 * 60 * 1000;
    Date.now = () => futureTime;

    try {
      await t.mutation(internal.verifications.timeoutStale, {});
    } finally {
      Date.now = originalDateNow;
    }

    const verification = await t.run(async (ctx) => ctx.db.get(verificationId));
    expect(verification!.status).toBe("failed");
    expect(verification!.errorLog).toContain("pending state for >10 minutes");

    const submission = await t.run(async (ctx) => ctx.db.get(submissionId));
    expect(submission!.status).toBe("failed");
  });

  it("pending verification under 10min is not affected", async () => {
    const t = convexTest(schema);
    const { verificationId, submissionId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, {
        status: "pending",
      });
      // _creationTime is set to ~now by convex-test, so it is well under 10 min
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "pending",
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId };
    });

    await t.mutation(internal.verifications.timeoutStale, {});

    const verification = await t.run(async (ctx) => ctx.db.get(verificationId));
    expect(verification!.status).toBe("pending");
    expect(verification!.errorLog).toBeUndefined();

    const submission = await t.run(async (ctx) => ctx.db.get(submissionId));
    expect(submission!.status).toBe("pending");
  });
});

describe("worker configuration fail-closed", () => {
  it("runVerification fails verification/submission when worker URL is missing", async () => {
    const t = convexTest(schema);
    const { verificationId, submissionId, bountyId } = await t.run(async (ctx) => {
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

    const originalWorkerUrl = process.env.WORKER_API_URL;
    delete process.env.WORKER_API_URL;
    try {
      await t.action(internal.verifications.runVerification, {
        verificationId,
        submissionId,
        bountyId,
      });
    } finally {
      process.env.WORKER_API_URL = originalWorkerUrl;
    }

    const verification = await t.run(async (ctx) => ctx.db.get(verificationId));
    const submission = await t.run(async (ctx) => ctx.db.get(submissionId));
    expect(verification?.status).toBe("failed");
    expect(verification?.errorLog).toContain("WORKER_API_URL");
    expect(submission?.status).toBe("failed");
  });

  it("runVerificationFromDiff fails verification/submission when worker URL is missing", async () => {
    const t = convexTest(schema);
    const { verificationId, submissionId, bountyId } = await t.run(async (ctx) => {
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

    const originalWorkerUrl = process.env.WORKER_API_URL;
    delete process.env.WORKER_API_URL;
    try {
      await t.action(internal.verifications.runVerificationFromDiff, {
        verificationId,
        submissionId,
        bountyId,
        baseRepoUrl: "https://github.com/acme/repo",
        baseCommitSha: "a".repeat(40),
        diffPatch: "diff --git a/file.ts b/file.ts\n",
        sourceWorkspaceId: "ws_test_123",
      });
    } finally {
      process.env.WORKER_API_URL = originalWorkerUrl;
    }

    const verification = await t.run(async (ctx) => ctx.db.get(verificationId));
    const submission = await t.run(async (ctx) => ctx.db.get(submissionId));
    expect(verification?.status).toBe("failed");
    expect(verification?.errorLog).toContain("WORKER_API_URL");
    expect(submission?.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// triggerPayoutOnVerificationPass guards
// ---------------------------------------------------------------------------

describe("triggerPayoutOnVerificationPass", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips if verification status is not passed", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "in_progress",
        paymentMethod: "stripe",
        escrowStatus: "funded",
      });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "failed" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "failed", // NOT passed
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId };
    });

    // Should return silently without creating a payment
    await t.action(internal.verifications.triggerPayoutOnVerificationPass, {
      verificationId: ids.verificationId,
      bountyId: ids.bountyId,
      submissionId: ids.submissionId,
    });

    const payment = await t.run(async (ctx) =>
      ctx.db
        .query("payments")
        .withIndex("by_bountyId", (q: any) => q.eq("bountyId", ids.bountyId))
        .first()
    );
    expect(payment).toBeNull();
  });

  it("skips for non-stripe payment methods", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "in_progress",
        paymentMethod: "web3", // NOT stripe
        escrowStatus: "funded",
      });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "passed" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "passed",
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId };
    });

    await t.action(internal.verifications.triggerPayoutOnVerificationPass, {
      verificationId: ids.verificationId,
      bountyId: ids.bountyId,
      submissionId: ids.submissionId,
    });

    const payment = await t.run(async (ctx) =>
      ctx.db
        .query("payments")
        .withIndex("by_bountyId", (q: any) => q.eq("bountyId", ids.bountyId))
        .first()
    );
    expect(payment).toBeNull();
  });

  it("skips if escrow is not funded", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "in_progress",
        paymentMethod: "stripe",
        escrowStatus: "unfunded", // NOT funded
      });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "passed" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "passed",
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId };
    });

    await t.action(internal.verifications.triggerPayoutOnVerificationPass, {
      verificationId: ids.verificationId,
      bountyId: ids.bountyId,
      submissionId: ids.submissionId,
    });

    const payment = await t.run(async (ctx) =>
      ctx.db
        .query("payments")
        .withIndex("by_bountyId", (q: any) => q.eq("bountyId", ids.bountyId))
        .first()
    );
    expect(payment).toBeNull();
  });

  it("skips if payment record already exists (duplicate prevention)", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "in_progress",
        paymentMethod: "stripe",
        escrowStatus: "funded",
      });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "passed" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "passed",
        timeoutSeconds: 600,
      });
      // Pre-existing payment record (pending = non-failed)
      await ctx.db.insert("payments" as any, {
        bountyId,
        recipientId: agentId,
        amount: 100,
        currency: "USD",
        method: "stripe",
        status: "pending",
        createdAt: Date.now(),
      });
      return { verificationId, submissionId, bountyId };
    });

    // Should skip because a pending payment already exists
    await t.action(internal.verifications.triggerPayoutOnVerificationPass, {
      verificationId: ids.verificationId,
      bountyId: ids.bountyId,
      submissionId: ids.submissionId,
    });

    // Only one payment should exist (the pre-existing one)
    const payments = await t.run(async (ctx) =>
      ctx.db
        .query("payments")
        .withIndex("by_bountyId", (q: any) => q.eq("bountyId", ids.bountyId))
        .collect()
    );
    expect(payments).toHaveLength(1);
  });

  it("completes test bounty without payout and records hello + handshake", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "in_progress",
        paymentMethod: "stripe",
        escrowStatus: "funded",
        isTestBounty: true,
        testBountyKind: "agenthello_v1",
        testBountyAgentIdentifier: String(agentId),
      });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "passed" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "passed",
        timeoutSeconds: 600,
      });
      const claimId = await seedClaim(ctx, bountyId, agentId, { status: "active" });
      return { verificationId, submissionId, bountyId, claimId };
    });

    await t.action(internal.verifications.triggerPayoutOnVerificationPass, {
      verificationId: ids.verificationId,
      bountyId: ids.bountyId,
      submissionId: ids.submissionId,
    });

    const state = await t.run(async (ctx) => {
      const payments = await ctx.db
        .query("payments")
        .withIndex("by_bountyId", (q: any) => q.eq("bountyId", ids.bountyId))
        .collect();
      const bounty = await ctx.db.get(ids.bountyId);
      const claim = await ctx.db.get(ids.claimId);
      const hellos = await ctx.db
        .query("agentHellos")
        .withIndex("by_bountyId", (q: any) => q.eq("bountyId", ids.bountyId))
        .collect();
      const handshakes = await ctx.db
        .query("stripeHandshakeChecks")
        .withIndex("by_bountyId", (q: any) => q.eq("bountyId", ids.bountyId))
        .collect();
      return { payments, bounty, claim, hellos, handshakes };
    });

    expect(state.payments).toHaveLength(0);
    expect(state.bounty?.status).toBe("completed");
    expect(state.claim?.status).toBe("completed");
    expect(state.hellos).toHaveLength(1);
    expect(state.hellos[0]?.message).toContain("hello from");
    expect(state.handshakes).toHaveLength(1);
  });

  it("emails bounty creator when test bounty is solved and PR is available", async () => {
    const t = convexTest(schema);
    const creatorEmail = "creator@example.com";
    const prUrl = "https://github.com/acme/repo/pull/42";
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { email: creatorEmail });
      const agentId = await seedUser(ctx, { role: "agent", name: "Agent Alice" });
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "in_progress",
        paymentMethod: "stripe",
        escrowStatus: "funded",
        isTestBounty: true,
        testBountyKind: "agenthello_v1",
        testBountyAgentIdentifier: String(agentId),
      });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "passed" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "passed",
        timeoutSeconds: 600,
      });
      const claimId = await seedClaim(ctx, bountyId, agentId, { status: "active" });
      await ctx.db.insert("devWorkspaces" as any, {
        claimId,
        bountyId,
        agentId,
        workspaceId: "ws_test_email_1",
        workerHost: "https://worker-host.local",
        status: "ready",
        language: "typescript",
        repositoryUrl: "https://gitlab.com/acme/repo",
        baseCommitSha: "a".repeat(40),
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      return { verificationId, submissionId, bountyId };
    });

    const originalWorkerUrl = process.env.WORKER_API_URL;
    const originalWorkerSecret = process.env.WORKER_SHARED_SECRET;
    const originalResendApiKey = process.env.RESEND_API_KEY;
    const originalWaitlistFromEmail = process.env.WAITLIST_FROM_EMAIL;
    process.env.WORKER_API_URL = "https://worker-api.local";
    process.env.WORKER_SHARED_SECRET = "test-secret";
    process.env.RESEND_API_KEY = "re_test_123";
    process.env.WAITLIST_FROM_EMAIL = "arcagent <waitlist@arcagent.dev>";

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            hasChanges: true,
            diffPatch: "diff --git a/file.ts b/file.ts\n",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            pullRequestUrl: prUrl,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    try {
      await t.action(internal.verifications.triggerPayoutOnVerificationPass, {
        verificationId: ids.verificationId,
        bountyId: ids.bountyId,
        submissionId: ids.submissionId,
      });
    } finally {
      process.env.WORKER_API_URL = originalWorkerUrl;
      process.env.WORKER_SHARED_SECRET = originalWorkerSecret;
      process.env.RESEND_API_KEY = originalResendApiKey;
      process.env.WAITLIST_FROM_EMAIL = originalWaitlistFromEmail;
    }

    const resendCall = mockFetch.mock.calls.find(
      (call) => call[0] === "https://api.resend.com/emails",
    );
    expect(resendCall).toBeDefined();

    const resendBody = JSON.parse(((resendCall?.[1] as RequestInit).body as string) ?? "{}");
    expect(resendBody.to).toEqual([creatorEmail]);
    expect(resendBody.text).toContain(prUrl);
    expect(resendBody.html).toContain(prUrl);
  });
});
