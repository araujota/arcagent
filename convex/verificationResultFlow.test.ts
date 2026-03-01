import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser, seedBounty, seedSubmission, seedVerification } from "./__tests__/helpers";

/**
 * Tests the chain of mutations that the /api/verification/result HTTP handler
 * calls. We can't test the HTTP action directly with convex-test, but we can
 * test the internal mutations it invokes.
 */

describe("verification result processing", () => {
  it("happy path (pass): gate results recorded, verification→passed, submission→passed", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "running" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "running",
        startedAt: Date.now(),
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId, agentId };
    });

    // 1. Record gate results
    await t.mutation(internal.sanityGates.record, {
      verificationId: ids.verificationId,
      gateType: "build",
      tool: "npm ci",
      status: "passed",
    });
    await t.mutation(internal.sanityGates.record, {
      verificationId: ids.verificationId,
      gateType: "lint",
      tool: "eslint",
      status: "passed",
    });

    // 2. Update verification status
    await t.mutation(internal.verifications.updateResult, {
      verificationId: ids.verificationId,
      status: "passed",
      completedAt: Date.now(),
    });

    // 3. Update submission status
    await t.mutation(internal.submissions.updateStatus, {
      submissionId: ids.submissionId,
      status: "passed",
    });

    // Verify
    const verification = await t.run(async (ctx) => ctx.db.get(ids.verificationId));
    expect(verification!.status).toBe("passed");
    expect(verification!.completedAt).toBeDefined();

    const submission = await t.run(async (ctx) => ctx.db.get(ids.submissionId));
    expect(submission!.status).toBe("passed");

    const gates = await t.run(async (ctx) =>
      ctx.db
        .query("sanityGates")
        .withIndex("by_verificationId", (q: any) =>
          q.eq("verificationId", ids.verificationId)
        )
        .collect()
    );
    expect(gates).toHaveLength(2);
    expect(gates.map((g: any) => g.gateType)).toContain("build");
    expect(gates.map((g: any) => g.gateType)).toContain("lint");
  });

  it("fail result: gate results recorded, verification→failed, submission→failed", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "running" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "running",
        startedAt: Date.now(),
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId };
    });

    await t.mutation(internal.sanityGates.record, {
      verificationId: ids.verificationId,
      gateType: "build",
      tool: "npm ci",
      status: "failed",
      issues: ["Build failed: exit code 1"],
    });

    await t.mutation(internal.verifications.updateResult, {
      verificationId: ids.verificationId,
      status: "failed",
      completedAt: Date.now(),
    });

    await t.mutation(internal.submissions.updateStatus, {
      submissionId: ids.submissionId,
      status: "failed",
    });

    const verification = await t.run(async (ctx) => ctx.db.get(ids.verificationId));
    expect(verification!.status).toBe("failed");

    const submission = await t.run(async (ctx) => ctx.db.get(ids.submissionId));
    expect(submission!.status).toBe("failed");

    const gates = await t.run(async (ctx) =>
      ctx.db
        .query("sanityGates")
        .withIndex("by_verificationId", (q: any) =>
          q.eq("verificationId", ids.verificationId)
        )
        .collect()
    );
    expect(gates).toHaveLength(1);
    expect(gates[0].status).toBe("failed");
  });

  it("M12 guard: getBySubmissionInternal returns terminal verification for late-result guard", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "failed" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "failed",
        completedAt: Date.now(),
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId };
    });

    // The HTTP handler checks verification.status before processing results.
    // Here we verify the query returns the terminal state correctly.
    const verification = await t.query(internal.verifications.getBySubmissionInternal, {
      submissionId: ids.submissionId,
    });
    expect(verification).not.toBeNull();
    expect(verification!.status).toBe("failed");
    // The HTTP handler would return { success: false, reason: "already in terminal state" }
  });

  it("step results: BDD steps created with correct visibility tags", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "running" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "running",
        startedAt: Date.now(),
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId };
    });

    await t.mutation(internal.verificationSteps.createInternal, {
      steps: [
        {
          verificationId: ids.verificationId,
          scenarioName: "User can login",
          featureName: "Auth",
          status: "pass",
          executionTimeMs: 150,
          output: "All assertions passed",
          stepNumber: 1,
          visibility: "public",
        },
        {
          verificationId: ids.verificationId,
          scenarioName: "SQL injection blocked",
          featureName: "Security",
          status: "pass",
          executionTimeMs: 200,
          stepNumber: 2,
          visibility: "hidden",
        },
      ],
    });

    const steps = await t.run(async (ctx) =>
      ctx.db
        .query("verificationSteps")
        .withIndex("by_verificationId", (q: any) =>
          q.eq("verificationId", ids.verificationId)
        )
        .collect()
    );
    expect(steps).toHaveLength(2);
    expect(steps.find((s: any) => s.scenarioName === "User can login")!.visibility).toBe("public");
    expect(steps.find((s: any) => s.scenarioName === "SQL injection blocked")!.visibility).toBe("hidden");
  });

  it("gate type mapping: worker gate names map to correct Convex gate types", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "running" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "running",
        startedAt: Date.now(),
        timeoutSeconds: 600,
      });
      return { verificationId, submissionId, bountyId };
    });

    // These are the gate types the HTTP handler maps from worker names
    const gateTypes = ["build", "lint", "typecheck", "security", "sonarqube", "snyk", "memory"] as const;

    for (const gateType of gateTypes) {
      await t.mutation(internal.sanityGates.record, {
        verificationId: ids.verificationId,
        gateType,
        tool: `${gateType}-tool`,
        status: "passed",
      });
    }

    const gates = await t.run(async (ctx) =>
      ctx.db
        .query("sanityGates")
        .withIndex("by_verificationId", (q: any) =>
          q.eq("verificationId", ids.verificationId)
        )
        .collect()
    );
    expect(gates).toHaveLength(7);
    const recordedTypes = gates.map((g: any) => g.gateType).sort();
    expect(recordedTypes).toEqual([...gateTypes].sort());
  });

  it("persists structured gate details and feedback JSON", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "running" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "running",
        startedAt: Date.now(),
        timeoutSeconds: 600,
      });
      return { verificationId };
    });

    await t.mutation(internal.sanityGates.record, {
      verificationId: ids.verificationId,
      gateType: "snyk",
      tool: "snyk test",
      status: "failed",
      issues: ["Snyk found 1 high severity issue"],
      detailsJson: JSON.stringify({ highCount: 1, criticalCount: 0 }),
    });

    const feedbackJson = JSON.stringify({
      overallStatus: "fail",
      actionItems: ["Update vulnerable dependency"],
    });

    await t.mutation(internal.verifications.updateResult, {
      verificationId: ids.verificationId,
      status: "failed",
      feedbackJson,
      completedAt: Date.now(),
    });

    const verification = await t.run(async (ctx) => ctx.db.get(ids.verificationId));
    expect(verification?.feedbackJson).toBe(feedbackJson);

    const gates = await t.run(async (ctx) =>
      ctx.db
        .query("sanityGates")
        .withIndex("by_verificationId", (q: any) =>
          q.eq("verificationId", ids.verificationId)
        )
        .collect()
    );
    expect(gates).toHaveLength(1);
    expect(gates[0].detailsJson).toBe(JSON.stringify({ highCount: 1, criticalCount: 0 }));
  });

  it("agent status includes hidden scenario feedback while keeping hidden suites unreadable", async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, { status: "in_progress" });
      const submissionId = await seedSubmission(ctx, bountyId, agentId, { status: "running" });
      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "running",
        startedAt: Date.now(),
        timeoutSeconds: 600,
      });
      return { verificationId };
    });

    await t.mutation(internal.verificationSteps.createInternal, {
      steps: [
        {
          verificationId: ids.verificationId,
          scenarioName: "Public flow works",
          featureName: "Public Feature",
          status: "pass",
          executionTimeMs: 40,
          stepNumber: 1,
          visibility: "public",
        },
        {
          verificationId: ids.verificationId,
          scenarioName: "Hidden SQL edge case",
          featureName: "Hidden Feature",
          status: "fail",
          executionTimeMs: 60,
          output: "Expected 200 but got 500",
          stepNumber: 2,
          visibility: "hidden",
        },
        {
          verificationId: ids.verificationId,
          scenarioName: "Hidden timeout edge case",
          featureName: "Hidden Feature",
          status: "error",
          executionTimeMs: 5000,
          output: "Timed out after 5000ms waiting for response",
          stepNumber: 3,
          visibility: "hidden",
        },
      ],
    });

    const status = await t.query(internal.verifications.getAgentStatus, {
      verificationId: ids.verificationId,
    });

    expect(status).not.toBeNull();
    expect(status!.steps).toHaveLength(3);
    expect(status!.steps.some((s: any) => s.scenarioName === "Public flow works")).toBe(true);
    expect(status!.steps.some((s: any) => s.scenarioName === "Hidden SQL edge case")).toBe(true);
    expect(status!.hiddenSummary?.failed).toBe(2);

    const mechanisms = status!.hiddenFailureMechanisms ?? [];
    expect(mechanisms.length).toBeGreaterThanOrEqual(2);
    expect(mechanisms.some((m: any) => m.key === "assertion_mismatch")).toBe(true);
    expect(mechanisms.some((m: any) => m.key === "timeout_or_hang")).toBe(true);

    const serialized = JSON.stringify(status);
    expect(serialized).toContain("Hidden SQL edge case");
    expect(serialized).toContain("Hidden Feature");
  });
});
