/**
 * Shared factory functions for convex-test data seeding.
 */
import { GenericMutationCtx, GenericDataModel } from "convex/server";

type Ctx = GenericMutationCtx<GenericDataModel>;

export async function seedUser(
  ctx: Ctx,
  overrides: Record<string, unknown> = {},
) {
  const id = Math.random().toString(36).slice(2, 10);
  return await ctx.db.insert("users" as any, {
    clerkId: `clerk_${id}`,
    name: overrides.name ?? `User ${id}`,
    email: overrides.email ?? `user-${id}@test.com`,
    role: overrides.role ?? "creator",
    ...overrides,
  });
}

export async function seedBounty(
  ctx: Ctx,
  creatorId: any,
  overrides: Record<string, unknown> = {},
) {
  return await ctx.db.insert("bounties" as any, {
    title: overrides.title ?? "Test Bounty",
    description: overrides.description ?? "A test bounty description that is long enough",
    creatorId,
    status: overrides.status ?? "active",
    reward: overrides.reward ?? 100,
    rewardCurrency: overrides.rewardCurrency ?? "USD",
    paymentMethod: overrides.paymentMethod ?? "stripe",
    escrowStatus: overrides.escrowStatus ?? "funded",
    tosAccepted: overrides.tosAccepted ?? true,
    ...overrides,
  });
}

export async function seedClaim(
  ctx: Ctx,
  bountyId: any,
  agentId: any,
  overrides: Record<string, unknown> = {},
) {
  return await ctx.db.insert("bountyClaims" as any, {
    bountyId,
    agentId,
    status: overrides.status ?? "active",
    claimedAt: overrides.claimedAt ?? Date.now(),
    expiresAt: overrides.expiresAt ?? Date.now() + 4 * 60 * 60 * 1000,
    ...overrides,
  });
}

export async function seedSubmission(
  ctx: Ctx,
  bountyId: any,
  agentId: any,
  overrides: Record<string, unknown> = {},
) {
  return await ctx.db.insert("submissions" as any, {
    bountyId,
    agentId,
    repositoryUrl: overrides.repositoryUrl ?? "https://github.com/test/repo",
    commitHash: overrides.commitHash ?? "abc1234",
    status: overrides.status ?? "pending",
    ...overrides,
  });
}

export async function seedVerification(
  ctx: Ctx,
  submissionId: any,
  bountyId: any,
  overrides: Record<string, unknown> = {},
) {
  return await ctx.db.insert("verifications" as any, {
    submissionId,
    bountyId,
    status: overrides.status ?? "pending",
    timeoutSeconds: overrides.timeoutSeconds ?? 600,
    ...overrides,
  });
}

export async function seedTestSuite(
  ctx: Ctx,
  bountyId: any,
  overrides: Record<string, unknown> = {},
) {
  return await ctx.db.insert("testSuites" as any, {
    bountyId,
    title: overrides.title ?? "Test Suite",
    version: overrides.version ?? 1,
    gherkinContent: overrides.gherkinContent ?? "Feature: Test\n  Scenario: Example\n    Given something",
    visibility: overrides.visibility ?? "public",
    ...overrides,
  });
}

export async function seedGeneratedTest(
  ctx: Ctx,
  bountyId: any,
  conversationId: any,
  overrides: Record<string, unknown> = {},
) {
  return await ctx.db.insert("generatedTests" as any, {
    bountyId,
    conversationId,
    version: overrides.version ?? 1,
    gherkinPublic: overrides.gherkinPublic ?? "Feature: Public",
    gherkinHidden: overrides.gherkinHidden ?? "Feature: Hidden",
    stepDefinitions: overrides.stepDefinitions ?? "// step defs",
    testFramework: overrides.testFramework ?? "vitest",
    testLanguage: overrides.testLanguage ?? "typescript",
    status: overrides.status ?? "draft",
    llmModel: overrides.llmModel ?? "claude-3",
    ...overrides,
  });
}

export async function seedConversation(
  ctx: Ctx,
  bountyId: any,
  overrides: Record<string, unknown> = {},
) {
  return await ctx.db.insert("conversations" as any, {
    bountyId,
    status: overrides.status ?? "gathering",
    messages: overrides.messages ?? [],
    ...overrides,
  });
}

export async function seedRepoConnection(
  ctx: Ctx,
  bountyId: any,
  overrides: Record<string, unknown> = {},
) {
  return await ctx.db.insert("repoConnections" as any, {
    bountyId,
    repositoryUrl: overrides.repositoryUrl ?? "https://github.com/test/repo",
    owner: overrides.owner ?? "test",
    repo: overrides.repo ?? "repo",
    provider: overrides.provider ?? "github",
    defaultBranch: overrides.defaultBranch ?? "main",
    commitSha: overrides.commitSha ?? "",
    status: overrides.status ?? "pending",
    ...overrides,
  });
}

export async function seedRating(
  ctx: Ctx,
  bountyId: any,
  agentId: any,
  creatorId: any,
  overrides: Record<string, unknown> = {},
) {
  return await ctx.db.insert("agentRatings" as any, {
    bountyId,
    agentId,
    creatorId,
    codeQuality: overrides.codeQuality ?? 4,
    speed: overrides.speed ?? 4,
    mergedWithoutChanges: overrides.mergedWithoutChanges ?? 4,
    communication: overrides.communication ?? 4,
    testCoverage: overrides.testCoverage ?? 4,
    tierEligible: overrides.tierEligible ?? true,
    createdAt: overrides.createdAt ?? Date.now(),
    ...overrides,
  });
}
