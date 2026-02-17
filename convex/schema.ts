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
    stripeCustomerId: v.optional(v.string()),
    stripeConnectAccountId: v.optional(v.string()),
    stripeConnectOnboardingComplete: v.optional(v.boolean()),
    isTechnical: v.optional(v.boolean()),
    onboardingComplete: v.optional(v.boolean()),
    onboardingStep: v.optional(v.number()),
    hasPaymentMethod: v.optional(v.boolean()),
    gateSettings: v.optional(v.object({
      snykEnabled: v.optional(v.boolean()),
      sonarqubeEnabled: v.optional(v.boolean()),
    })),
  })
    .index("by_clerkId", ["clerkId"])
    .index("by_email", ["email"])
    .index("by_role", ["role"])
    .index("by_stripeConnectAccountId", ["stripeConnectAccountId"]),

  bounties: defineTable({
    title: v.string(),
    description: v.string(),
    creatorId: v.id("users"),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("disputed"),
      v.literal("cancelled")
    ),
    reward: v.number(),
    rewardCurrency: v.string(),
    paymentMethod: v.union(v.literal("stripe"), v.literal("web3")),
    deadline: v.optional(v.number()),
    repositoryUrl: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    repoConnectionId: v.optional(v.id("repoConnections")),
    claimDurationHours: v.optional(v.number()),
    stripePaymentIntentId: v.optional(v.string()),
    escrowStatus: v.optional(
      v.union(
        v.literal("unfunded"),
        v.literal("funded"),
        v.literal("released"),
        v.literal("refunded")
      )
    ),
    // ZTACO fields
    platformFeePercent: v.optional(v.number()),
    platformFeeCents: v.optional(v.number()),
    ztacoMode: v.optional(v.boolean()),
    relevantPaths: v.optional(v.array(v.string())),
    // TOS fields
    tosAccepted: v.optional(v.boolean()),
    tosAcceptedAt: v.optional(v.number()),
    tosVersion: v.optional(v.string()),
    // PM tool traceability
    pmIssueKey: v.optional(v.string()),
    pmProvider: v.optional(v.union(
      v.literal("jira"),
      v.literal("linear"),
      v.literal("asana"),
      v.literal("monday")
    )),
    pmConnectionId: v.optional(v.id("pmConnections")),
    requiredTier: v.optional(v.union(
      v.literal("S"),
      v.literal("A"),
      v.literal("B"),
      v.literal("C"),
      v.literal("D")
    )),
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
    source: v.optional(v.union(v.literal("manual"), v.literal("imported"), v.literal("generated"))),
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
    attemptNumber: v.optional(v.number()),
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
    feedbackJson: v.optional(v.string()),
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
      v.literal("sonarqube"),
      v.literal("snyk"),
      v.literal("memory")
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
    visibility: v.optional(v.union(v.literal("public"), v.literal("hidden"))),
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
    stripePaymentIntentId: v.optional(v.string()),
    stripeTransferId: v.optional(v.string()),
    platformFeeCents: v.optional(v.number()),
    solverAmountCents: v.optional(v.number()),
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
      v.literal("failed"),
      v.literal("cleaned")
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
    trackedBranch: v.optional(v.string()),
    webhookId: v.optional(v.string()),
    detectedFeatureFiles: v.optional(v.array(v.object({
      filePath: v.string(),
      content: v.string(),
    }))),
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
    autonomous: v.optional(v.boolean()),
  }).index("by_bountyId", ["bountyId"]),

  generatedTests: defineTable({
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
    version: v.number(),
    gherkinPublic: v.string(),
    gherkinHidden: v.string(),
    stepDefinitions: v.string(),
    stepDefinitionsPublic: v.optional(v.string()),
    stepDefinitionsHidden: v.optional(v.string()),
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
    // Agent-breed abstraction
    toolProfile: v.optional(v.string()),
    agentPlatform: v.optional(v.string()),
  })
    .index("by_keyHash", ["keyHash"])
    .index("by_userId", ["userId"])
    .index("by_status", ["status"]),

  pmConnections: defineTable({
    userId: v.id("users"),
    provider: v.union(
      v.literal("jira"),
      v.literal("linear"),
      v.literal("asana"),
      v.literal("monday")
    ),
    displayName: v.string(),
    domain: v.optional(v.string()),
    email: v.optional(v.string()),
    apiTokenHash: v.string(),
    apiTokenPrefix: v.string(),
    authMethod: v.union(v.literal("api_token"), v.literal("oauth")),
    oauthAccessToken: v.optional(v.string()),
    oauthRefreshToken: v.optional(v.string()),
    oauthExpiresAt: v.optional(v.number()),
    status: v.union(v.literal("active"), v.literal("revoked")),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_and_status", ["userId", "status"])
    .index("by_userId_and_provider", ["userId", "provider"]),

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
    featureBranchName: v.optional(v.string()),
    featureBranchRepo: v.optional(v.string()),
  })
    .index("by_bountyId", ["bountyId"])
    .index("by_agentId", ["agentId"])
    .index("by_bountyId_and_status", ["bountyId", "status"])
    .index("by_agentId_and_status", ["agentId", "status"])
    .index("by_expiresAt", ["expiresAt"]),

  savedRepos: defineTable({
    userId: v.id("users"),
    repositoryUrl: v.string(),
    owner: v.string(),
    repo: v.string(),
    languages: v.optional(v.array(v.string())),
    hidden: v.optional(v.boolean()),
    lastUsedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_and_repositoryUrl", ["userId", "repositoryUrl"]),

  platformStats: defineTable({
    avgTimeToClaimMs: v.number(),
    avgTimeToSolveMs: v.number(),
    totalBountiesProcessed: v.number(),
    totalUsers: v.number(),
    totalRepos: v.number(),
    computedAt: v.number(),
  }),

  // === Agent Tiering System ===

  agentRatings: defineTable({
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
    creatorId: v.id("users"),
    codeQuality: v.number(),
    speed: v.number(),
    mergedWithoutChanges: v.number(),
    communication: v.number(),
    testCoverage: v.number(),
    comment: v.optional(v.string()),
    tierEligible: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_agentId", ["agentId"])
    .index("by_bountyId", ["bountyId"])
    .index("by_agentId_and_createdAt", ["agentId", "createdAt"]),

  agentStats: defineTable({
    agentId: v.id("users"),
    totalBountiesCompleted: v.number(),
    totalBountiesClaimed: v.number(),
    totalBountiesExpired: v.number(),
    totalSubmissions: v.number(),
    totalFirstAttemptPasses: v.number(),
    totalGateWarnings: v.number(),
    totalGatePasses: v.number(),
    avgTimeToResolutionMs: v.number(),
    avgSubmissionsPerBounty: v.number(),
    firstAttemptPassRate: v.number(),
    completionRate: v.number(),
    gateQualityScore: v.number(),
    avgCreatorRating: v.number(),
    totalRatings: v.number(),
    uniqueRaters: v.number(),
    singleCreatorConcentration: v.number(),
    compositeScore: v.number(),
    tier: v.union(
      v.literal("S"),
      v.literal("A"),
      v.literal("B"),
      v.literal("C"),
      v.literal("D"),
      v.literal("unranked")
    ),
    lastComputedAt: v.number(),
  })
    .index("by_agentId", ["agentId"])
    .index("by_compositeScore", ["compositeScore"])
    .index("by_tier", ["tier"]),

  devWorkspaces: defineTable({
    claimId: v.id("bountyClaims"),
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
    workspaceId: v.string(),
    workerHost: v.string(),
    vmId: v.optional(v.string()),
    status: v.union(
      v.literal("provisioning"),
      v.literal("ready"),
      v.literal("error"),
      v.literal("destroyed"),
    ),
    language: v.string(),
    repositoryUrl: v.string(),
    baseCommitSha: v.string(),
    createdAt: v.number(),
    readyAt: v.optional(v.number()),
    expiresAt: v.number(),
    destroyedAt: v.optional(v.number()),
    destroyReason: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    // Crash recovery metadata
    firecrackerPid: v.optional(v.number()),
    vsockSocketPath: v.optional(v.string()),
    tapDevice: v.optional(v.string()),
    overlayPath: v.optional(v.string()),
    workerInstanceId: v.optional(v.string()),
    lastHeartbeatAt: v.optional(v.number()),
    defaultShellSessionId: v.optional(v.string()),
  })
    .index("by_claimId", ["claimId"])
    .index("by_agentId_and_status", ["agentId", "status"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_status", ["status"]),

  activityFeed: defineTable({
    type: v.union(
      v.literal("bounty_posted"),
      v.literal("bounty_claimed"),
      v.literal("bounty_resolved"),
      v.literal("payout_sent"),
      v.literal("agent_rated")
    ),
    bountyId: v.id("bounties"),
    bountyTitle: v.string(),
    amount: v.optional(v.number()),
    currency: v.optional(v.string()),
    actorName: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"]),

  notifications: defineTable({
    userId: v.id("users"),
    type: v.union(v.literal("new_bounty"), v.literal("payment_failed")),
    bountyId: v.id("bounties"),
    title: v.string(),
    message: v.string(),
    read: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_userId_and_read", ["userId", "read"])
    .index("by_userId", ["userId"]),

  waitlist: defineTable({
    email: v.string(),
    source: v.optional(v.string()),
    joinedAt: v.number(),
  }).index("by_email", ["email"]),

  // === Workspace Crash Reports ===

  workspaceCrashReports: defineTable({
    workspaceId: v.string(),
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
    claimId: v.id("bountyClaims"),
    vmId: v.string(),
    workerInstanceId: v.string(),

    // Crash classification
    crashType: v.union(
      v.literal("vm_process_exited"),
      v.literal("vm_unresponsive"),
      v.literal("worker_restart"),
      v.literal("oom_killed"),
      v.literal("disk_full"),
      v.literal("provision_failed"),
      v.literal("vsock_error"),
      v.literal("network_error"),
      v.literal("timeout"),
      v.literal("unknown"),
    ),

    // Diagnostics
    errorMessage: v.string(),
    lastKnownStatus: v.string(),
    vmUptimeMs: v.optional(v.number()),
    lastHeartbeatAt: v.optional(v.number()),
    lastActivityAt: v.optional(v.number()),
    resourceUsage: v.optional(v.object({
      cpuPercent: v.optional(v.number()),
      memoryMb: v.optional(v.number()),
      diskMb: v.optional(v.number()),
    })),

    // Recovery outcome
    recovered: v.boolean(),
    recoveryAction: v.optional(v.union(
      v.literal("reconnected"),
      v.literal("reprovisioned"),
      v.literal("abandoned"),
    )),

    // Host context
    hostMetrics: v.optional(v.object({
      totalActiveVMs: v.optional(v.number()),
      hostMemoryUsedPercent: v.optional(v.number()),
      hostCpuUsedPercent: v.optional(v.number()),
    })),

    createdAt: v.number(),
  })
    .index("by_workspaceId", ["workspaceId"])
    .index("by_bountyId", ["bountyId"])
    .index("by_agentId", ["agentId"])
    .index("by_crashType", ["crashType"])
    .index("by_createdAt", ["createdAt"]),
});
