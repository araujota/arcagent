import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { seedUser, seedBounty, seedClaim, seedSubmission } from "./__tests__/helpers";

describe("Submissions", () => {
  describe("createFromMcp", () => {
    it("creates submission with valid inputs", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        await seedClaim(ctx, bountyId, agentId, { status: "active" });
        return { agentId, bountyId };
      });

      const submissionId = await t.mutation(internal.submissions.createFromMcp, {
        bountyId,
        agentId,
        repositoryUrl: "https://github.com/test/repo",
        commitHash: "abc1234def5678",
      });

      expect(submissionId).toBeDefined();
      const sub = await t.run(async (ctx) => ctx.db.get(submissionId));
      expect(sub?.status).toBe("pending");
    });

    it("rejects non-active/in_progress bounty", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "draft",
        });
        return { agentId, bountyId };
      });

      await expect(
        t.mutation(internal.submissions.createFromMcp, {
          bountyId,
          agentId,
          repositoryUrl: "https://github.com/test/repo",
          commitHash: "abc1234",
        }),
      ).rejects.toThrow("not accepting submissions");
    });

    it("SECURITY (P2-6): rejects submission past deadline", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
          deadline: Date.now() - 10000,
        });
        await seedClaim(ctx, bountyId, agentId, { status: "active" });
        return { agentId, bountyId };
      });

      await expect(
        t.mutation(internal.submissions.createFromMcp, {
          bountyId,
          agentId,
          repositoryUrl: "https://github.com/test/repo",
          commitHash: "abc1234",
        }),
      ).rejects.toThrow("deadline has passed");
    });

    it("validates commit hash format", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        await seedClaim(ctx, bountyId, agentId, { status: "active" });
        return { agentId, bountyId };
      });

      await expect(
        t.mutation(internal.submissions.createFromMcp, {
          bountyId,
          agentId,
          repositoryUrl: "https://github.com/test/repo",
          commitHash: "not-a-hash!",
        }),
      ).rejects.toThrow("Invalid commit hash");
    });

    it("requires active claim by submitting agent", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        // No claim created for this agent
        return { agentId, bountyId };
      });

      await expect(
        t.mutation(internal.submissions.createFromMcp, {
          bountyId,
          agentId,
          repositoryUrl: "https://github.com/test/repo",
          commitHash: "abc1234",
        }),
      ).rejects.toThrow("active claim");
    });

    it("rejects if pending submission exists (rate limit)", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        await seedClaim(ctx, bountyId, agentId, { status: "active" });
        await seedSubmission(ctx, bountyId, agentId, { status: "pending" });
        return { agentId, bountyId };
      });

      await expect(
        t.mutation(internal.submissions.createFromMcp, {
          bountyId,
          agentId,
          repositoryUrl: "https://github.com/test/repo",
          commitHash: "abc1234",
        }),
      ).rejects.toThrow("pending submission");
    });

    it("rejects if running submission exists (rate limit)", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        await seedClaim(ctx, bountyId, agentId, { status: "active" });
        await seedSubmission(ctx, bountyId, agentId, { status: "running" });
        return { agentId, bountyId };
      });

      await expect(
        t.mutation(internal.submissions.createFromMcp, {
          bountyId,
          agentId,
          repositoryUrl: "https://github.com/test/repo",
          commitHash: "abc1234",
        }),
      ).rejects.toThrow("running verification");
    });

    it("SECURITY (H7): enforces 20-submission max", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        await seedClaim(ctx, bountyId, agentId, { status: "active" });
        // Create 20 failed submissions
        for (let i = 0; i < 20; i++) {
          await seedSubmission(ctx, bountyId, agentId, {
            status: "failed",
            commitHash: `abc${1000 + i}`,
          });
        }
        return { agentId, bountyId };
      });

      await expect(
        t.mutation(internal.submissions.createFromMcp, {
          bountyId,
          agentId,
          repositoryUrl: "https://github.com/test/repo",
          commitHash: "abc9999",
        }),
      ).rejects.toThrow("Maximum attempts reached");
    });
  });

  describe("listByBounty (redaction)", () => {
    it("creator sees redacted repositoryUrl/commitHash on pending submission", async () => {
      const t = convexTest(schema);
      const { creatorClerkId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, {
          role: "creator",
          clerkId: "clerk_creator_redact",
        });
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        await seedSubmission(ctx, bountyId, agentId, {
          status: "pending",
          repositoryUrl: "https://github.com/agent/secret-repo",
          commitHash: "secret123",
        });
        return { creatorClerkId: "clerk_creator_redact", bountyId };
      });

      const authed = t.withIdentity({ subject: creatorClerkId });
      const submissions = await authed.query(api.submissions.listByBounty, {
        bountyId,
      });

      expect(submissions).toHaveLength(1);
      expect(submissions[0].repositoryUrl).toBe(
        "[redacted until verification completes]",
      );
      expect(submissions[0].commitHash).toBe(
        "[redacted until verification completes]",
      );
    });

    it("agent (non-creator) sees full data on their own submission", async () => {
      const t = convexTest(schema);
      const { agentClerkId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { role: "creator" });
        const agentId = await seedUser(ctx, {
          role: "agent",
          clerkId: "clerk_agent_view",
        });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        await seedSubmission(ctx, bountyId, agentId, {
          status: "pending",
          repositoryUrl: "https://github.com/agent/my-repo",
          commitHash: "abc1234",
        });
        return { agentClerkId: "clerk_agent_view", bountyId };
      });

      const authed = t.withIdentity({ subject: agentClerkId });
      const submissions = await authed.query(api.submissions.listByBounty, {
        bountyId,
      });

      expect(submissions).toHaveLength(1);
      // Non-creator sees unredacted data
      expect(submissions[0].repositoryUrl).toBe(
        "https://github.com/agent/my-repo",
      );
      expect(submissions[0].commitHash).toBe("abc1234");
    });

    it("creator sees full data on passed submission (terminal state)", async () => {
      const t = convexTest(schema);
      const { creatorClerkId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, {
          role: "creator",
          clerkId: "clerk_creator_terminal",
        });
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        await seedSubmission(ctx, bountyId, agentId, {
          status: "passed",
          repositoryUrl: "https://github.com/agent/visible-repo",
          commitHash: "visible123",
        });
        return { creatorClerkId: "clerk_creator_terminal", bountyId };
      });

      const authed = t.withIdentity({ subject: creatorClerkId });
      const submissions = await authed.query(api.submissions.listByBounty, {
        bountyId,
      });

      expect(submissions).toHaveLength(1);
      expect(submissions[0].repositoryUrl).toBe(
        "https://github.com/agent/visible-repo",
      );
      expect(submissions[0].commitHash).toBe("visible123");
    });
  });
});
