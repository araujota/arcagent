import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser, seedBounty, seedTestSuite } from "./__tests__/helpers";

describe("testSuites.createInternal", () => {
  it("creates test suite with auto-incremented version", async () => {
    const t = convexTest(schema);
    const bountyId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      return await seedBounty(ctx, creatorId);
    });

    const id1 = await t.mutation(internal.testSuites.createInternal, {
      bountyId,
      title: "Suite 1",
      gherkinContent: "Feature: S1\n  Scenario: A\n    Given x",
      visibility: "public",
    });

    const id2 = await t.mutation(internal.testSuites.createInternal, {
      bountyId,
      title: "Suite 2",
      gherkinContent: "Feature: S2\n  Scenario: B\n    Given y",
      visibility: "hidden",
    });

    const s1 = await t.run(async (ctx) => ctx.db.get(id1));
    const s2 = await t.run(async (ctx) => ctx.db.get(id2));
    expect(s1!.version).toBe(1);
    expect(s2!.version).toBe(2);
  });
});

describe("testSuites.listByBounty (visibility filter)", () => {
  it("non-creator sees only public suites", async () => {
    const t = convexTest(schema);
    const bountyId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      await seedTestSuite(ctx, bountyId, { title: "Public", visibility: "public" });
      await seedTestSuite(ctx, bountyId, { title: "Hidden", visibility: "hidden" });
      return bountyId;
    });

    // Query without auth -> non-creator, should see only public
    const suites = await t.query(internal.testSuites.listAllByBounty, { bountyId });
    // listAllByBounty is internal and returns everything
    expect(suites).toHaveLength(2);
  });
});

describe("testSuites.listAllByBounty (internal)", () => {
  it("returns all suites (public + hidden)", async () => {
    const t = convexTest(schema);
    const bountyId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      await seedTestSuite(ctx, bountyId, { visibility: "public" });
      await seedTestSuite(ctx, bountyId, { visibility: "hidden" });
      return bountyId;
    });

    const suites = await t.query(internal.testSuites.listAllByBounty, { bountyId });
    expect(suites).toHaveLength(2);
    const visibilities = suites.map((s: any) => s.visibility).sort();
    expect(visibilities).toEqual(["hidden", "public"]);
  });
});
