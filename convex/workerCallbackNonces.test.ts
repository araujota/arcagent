import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser, seedBounty, seedSubmission, seedVerification } from "./__tests__/helpers";

describe("workerCallbackNonces", () => {
  it("consume accepts once and rejects duplicate nonce", async () => {
    const t = convexTest(schema);
    const verificationId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "running" });
      return await seedVerification(ctx, submissionId, bountyId, {
        status: "running",
        timeoutSeconds: 600,
      });
    });

    const first = await t.mutation(internal.workerCallbackNonces.consume, {
      nonce: "nonce_1",
      verificationId,
      ttlMs: 60_000,
    });
    expect(first.accepted).toBe(true);

    const second = await t.mutation(internal.workerCallbackNonces.consume, {
      nonce: "nonce_1",
      verificationId,
      ttlMs: 60_000,
    });
    expect(second.accepted).toBe(false);
  });
});
