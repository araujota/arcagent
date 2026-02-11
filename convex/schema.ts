import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    name: v.string(),
    email: v.string(),
    role: v.union(v.literal("creator"), v.literal("agent"), v.literal("admin")),
    walletAddress: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    githubUsername: v.optional(v.string()),
    isApiAgent: v.optional(v.boolean()),
  })
    .index("by_clerkId", ["clerkId"])
    .index("by_email", ["email"])
    .index("by_role", ["role"]),

  bounties: defineTable({
    title: v.string(),
    description: v.string(),
    creatorId: v.id("users"),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("disputed")
    ),
    reward: v.number(),
    rewardCurrency: v.string(),
    paymentMethod: v.union(v.literal("stripe"), v.literal("web3")),
    deadline: v.optional(v.number()),
    repositoryUrl: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    repoConnectionId: v.optional(v.id("repoConnections")),
    claimDurationHours: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_creatorId", ["creatorId"])
    .index("by_creatorId_and_status", ["creatorId", "status"]),

  testSuites: defineTable({
    bountyId: v.id("bounties"),
    title: v.string(),
    version: v.number(),
    gherkinContent: v.string(),
    visibility: v.union(v.literal("public"), v.literal("hidden")),
  })
    .index("by_bountyId", ["bountyId"])
    .index("by_bountyId_and_visibility", ["bountyId", "visibility"]),

  submissions: defineTable({
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
    repositoryUrl: v.string(),
    commitHash: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("passed"),
      v.literal("failed")
    ),
    description: v.optional(v.string()),
  })
    .index("by_bountyId", ["bountyId"])
    .index("by_agentId", ["agentId"])
    .index("by_bountyId_and_status", ["bountyId", "status"]),

  verifications: defineTable({
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("passed"),
      v.literal("failed")
    ),
    result: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    timeoutSeconds: v.number(),
    errorLog: v.optional(v.string()),
  })
    .index("by_submissionId", ["submissionId"])
    .index("by_bountyId", ["bountyId"])
    .index("by_status", ["status"]),

  sanityGates: defineTable({
    verificationId: v.id("verifications"),
    gateType: v.union(
      v.literal("lint"),
      v.literal("typecheck"),
      v.literal("security"),
      v.literal("build"),
      v.literal("sonarqube")
    ),
    tool: v.string(),
    status: v.union(
      v.literal("passed"),
      v.literal("failed"),
      v.literal("warning")
    ),
    issues: v.optional(v.array(v.string())),
  }).index("by_verificationId", ["verificationId"]),

  verificationSteps: defineTable({
    verificationId: v.id("verifications"),
    scenarioName: v.string(),
    featureName: v.string(),
    status: v.union(
      v.literal("pass"),
      v.literal("fail"),
      v.literal("skip"),
      v.literal("error")
    ),
    executionTimeMs: v.number(),
    output: v.optional(v.string()),
    stepNumber: v.number(),
  })
    .index("by_verificationId", ["verificationId"])
    .index("by_verificationId_and_stepNumber", [
      "verificationId",
      "stepNumber",
    ]),

  payments: defineTable({
    bountyId: v.id("bounties"),
    recipientId: v.id("users"),
    amount: v.number(),
    currency: v.string(),
    method: v.union(v.literal("stripe"), v.literal("web3")),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed")
    ),
    transactionId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_bountyId", ["bountyId"])
    .index("by_recipientId", ["recipientId"])
    .index("by_status", ["status"]),

  // === NEW TABLES: Repo Intelligence Engine ===

  repoConnections: defineTable({
    bountyId: v.id("bounties"),
    repositoryUrl: v.string(),
    owner: v.string(),
    repo: v.string(),
    defaultBranch: v.string(),
    commitSha: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("fetching"),
      v.literal("parsing"),
      v.literal("indexing"),
      v.literal("ready"),
      v.literal("failed")
    ),
    totalFiles: v.optional(v.number()),
    totalSymbols: v.optional(v.number()),
    languages: v.optional(v.array(v.string())),
    errorMessage: v.optional(v.string()),
    lastIndexedAt: v.optional(v.number()),
    dockerfilePath: v.optional(v.string()),
    dockerfileContent: v.optional(v.string()),
    dockerfileSource: v.optional(
      v.union(
        v.literal("repo"),
        v.literal("generated"),
        v.literal("manual")
      )
    ),
  })
    .index("by_bountyId", ["bountyId"])
    .index("by_status", ["status"]),

  repoMaps: defineTable({
    repoConnectionId: v.id("repoConnections"),
    bountyId: v.id("bounties"),
    repoMapText: v.string(),
    symbolTableJson: v.string(),
    dependencyGraphJson: v.string(),
    version: v.number(),
  }).index("by_bountyId", ["bountyId"]),

  codeChunks: defineTable({
    repoConnectionId: v.id("repoConnections"),
    bountyId: v.id("bounties"),
    filePath: v.string(),
    symbolName: v.string(),
    symbolType: v.union(
      v.literal("function"),
      v.literal("class"),
      v.literal("interface"),
      v.literal("type"),
      v.literal("method"),
      v.literal("module"),
      v.literal("enum"),
      v.literal("constant")
    ),
    language: v.string(),
    content: v.string(),
    startLine: v.number(),
    endLine: v.number(),
    parentScope: v.optional(v.string()),
    signature: v.optional(v.string()),
    qdrantPointId: v.optional(v.string()),
  })
    .index("by_bountyId", ["bountyId"])
    .index("by_repoConnectionId", ["repoConnectionId"]),

  // === NEW TABLES: NL → BDD → TDD Pipeline ===

  conversations: defineTable({
    bountyId: v.id("bounties"),
    status: v.union(
      v.literal("gathering"),
      v.literal("clarifying"),
      v.literal("generating_bdd"),
      v.literal("generating_tdd"),
      v.literal("review"),
      v.literal("finalized")
    ),
    messages: v.array(
      v.object({
        role: v.union(
          v.literal("system"),
          v.literal("user"),
          v.literal("assistant")
        ),
        content: v.string(),
        timestamp: v.number(),
      })
    ),
    repoContextSnapshot: v.optional(v.string()),
  }).index("by_bountyId", ["bountyId"]),

  generatedTests: defineTable({
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
    version: v.number(),
    gherkinPublic: v.string(),
    gherkinHidden: v.string(),
    stepDefinitions: v.string(),
    testFramework: v.string(),
    testLanguage: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("approved"),
      v.literal("published")
    ),
    llmModel: v.string(),
  })
    .index("by_bountyId", ["bountyId"])
    .index("by_conversationId", ["conversationId"]),

  // === NEW TABLES: Verification Worker ===

  verificationJobs: defineTable({
    verificationId: v.id("verifications"),
    bountyId: v.id("bounties"),
    submissionId: v.id("submissions"),
    workerJobId: v.optional(v.string()),
    status: v.union(
      v.literal("queued"),
      v.literal("provisioning"),
      v.literal("running"),
      v.literal("teardown"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("timeout")
    ),
    currentGate: v.optional(v.string()),
    vmId: v.optional(v.string()),
    queuedAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    resourceUsage: v.optional(
      v.object({
        cpuPercent: v.optional(v.number()),
        memoryMb: v.optional(v.number()),
        diskMb: v.optional(v.number()),
      })
    ),
  })
    .index("by_verificationId", ["verificationId"])
    .index("by_status", ["status"]),

  // === MCP Server Tables ===

  apiKeys: defineTable({
    userId: v.id("users"),
    keyHash: v.string(),
    keyPrefix: v.string(),
    name: v.string(),
    scopes: v.array(v.string()),
    status: v.union(v.literal("active"), v.literal("revoked")),
    lastUsedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_keyHash", ["keyHash"])
    .index("by_userId", ["userId"])
    .index("by_status", ["status"]),

  bountyClaims: defineTable({
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
    status: v.union(
      v.literal("active"),
      v.literal("released"),
      v.literal("expired"),
      v.literal("completed")
    ),
    claimedAt: v.number(),
    expiresAt: v.number(),
    releasedAt: v.optional(v.number()),
    forkRepositoryUrl: v.optional(v.string()),
    forkAccessToken: v.optional(v.string()),
    forkTokenExpiresAt: v.optional(v.number()),
  })
    .index("by_bountyId", ["bountyId"])
    .index("by_agentId", ["agentId"])
    .index("by_bountyId_and_status", ["bountyId", "status"])
    .index("by_agentId_and_status", ["agentId", "status"])
    .index("by_expiresAt", ["expiresAt"]),
});
