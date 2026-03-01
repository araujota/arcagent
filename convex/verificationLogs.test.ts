import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedBounty, seedSubmission, seedUser, seedVerification } from "./__tests__/helpers";

describe("verification logs", () => {
  it("records and searches logs by verificationId", async () => {
    const t = convexTest(schema);

    const { verificationId, submissionId, bountyId, agentId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { role: "creator" });
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId);
      const submissionId = await seedSubmission(ctx, bountyId, agentId);
      const verificationId = await seedVerification(ctx, submissionId, bountyId);
      return { verificationId, submissionId, bountyId, agentId };
    });

    await t.mutation(internal.verifications.recordLogInternal, {
      verificationId,
      submissionId,
      bountyId,
      agentId,
      source: "verification_result_callback",
      level: "info",
      eventType: "callback_received",
      message: "callback received",
      detailsJson: JSON.stringify({ gateCount: 2 }),
    });

    const logs = await t.query(internal.verifications.searchLogsInternal, {
      verificationId,
      limit: 10,
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].eventType).toBe("callback_received");
    expect(logs[0].source).toBe("verification_result_callback");
  });

  it("supports multi-filter search over submission/bounty/agent/source/level", async () => {
    const t = convexTest(schema);

    const { verificationId, submissionId, bountyId, agentId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { role: "creator" });
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId);
      const submissionId = await seedSubmission(ctx, bountyId, agentId);
      const verificationId = await seedVerification(ctx, submissionId, bountyId);
      return { verificationId, submissionId, bountyId, agentId };
    });

    await t.mutation(internal.verifications.recordLogsBatchInternal, {
      logs: [
        {
          verificationId,
          submissionId,
          bountyId,
          agentId,
          source: "verification_result_callback",
          level: "error",
          eventType: "test_step_result",
          visibility: "hidden",
          message: "hidden scenario failed",
          detailsJson: JSON.stringify({ scenario: "A" }),
        },
        {
          verificationId,
          submissionId,
          bountyId,
          agentId,
          source: "verification_lifecycle",
          level: "info",
          eventType: "verification_result_persisted",
          message: "verification persisted",
        },
      ],
    });

    const logs = await t.query(internal.verifications.searchLogsInternal, {
      submissionId,
      bountyId,
      agentId,
      source: "verification_result_callback",
      level: "error",
      eventType: "test_step_result",
      visibility: "hidden",
      limit: 10,
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].message).toContain("hidden scenario failed");
  });

  it("honors result limits", async () => {
    const t = convexTest(schema);

    const { verificationId, submissionId, bountyId, agentId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { role: "creator" });
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId);
      const submissionId = await seedSubmission(ctx, bountyId, agentId);
      const verificationId = await seedVerification(ctx, submissionId, bountyId);
      return { verificationId, submissionId, bountyId, agentId };
    });

    await t.mutation(internal.verifications.recordLogsBatchInternal, {
      logs: Array.from({ length: 5 }, (_, i) => ({
        verificationId,
        submissionId,
        bountyId,
        agentId,
        source: "system" as const,
        level: "info" as const,
        eventType: `event_${i}`,
        message: `log ${i}`,
      })),
    });

    const logs = await t.query(internal.verifications.searchLogsInternal, {
      verificationId,
      limit: 2,
    });

    expect(logs).toHaveLength(2);
  });
});
