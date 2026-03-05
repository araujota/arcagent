import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { repoProviderValidator } from "./lib/repoProviders";

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
    // Test bounty metadata
    isTestBounty: v.optional(v.boolean()),
    testBountyKind: v.optional(v.union(v.literal("agenthello_v1"))),
    testBountyAgentIdentifier: v.optional(v.string()),
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
    detailsJson: v.optional(v.string()),
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

  verificationReceipts: defineTable({
    verificationId: v.id("verifications"),
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
    agentId: v.optional(v.id("users")),
    claimId: v.optional(v.id("bountyClaims")),
    attemptNumber: v.number(),
    legKey: v.string(),
    orderIndex: v.number(),
    status: v.union(
      v.literal("pass"),
      v.literal("fail"),
      v.literal("error"),
      v.literal("warning"),
      v.literal("unreached"),
      v.literal("skipped_policy"),
      v.literal("skipped_policy_due_process"),
    ),
    blocking: v.boolean(),
    unreachedByLegKey: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.number(),
    durationMs: v.number(),
    summaryLine: v.string(),
    rawBody: v.optional(v.string()),
    sarifJson: v.optional(v.string()),
    policyJson: v.optional(v.string()),
    metadataJson: v.optional(v.string()),
    normalizedJson: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_verificationId_and_orderIndex", ["verificationId", "orderIndex"])
    .index("by_submissionId_and_orderIndex", ["submissionId", "orderIndex"])
    .index("by_bountyId_and_createdAt", ["bountyId", "createdAt"]),

  verificationArtifacts: defineTable({
    verificationId: v.id("verifications"),
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
    agentId: v.optional(v.id("users")),
    claimId: v.optional(v.id("bountyClaims")),
    attemptNumber: v.number(),
    storageId: v.id("_storage"),
    filename: v.string(),
    contentType: v.string(),
    sha256: v.string(),
    bytes: v.number(),
    manifestJson: v.string(),
    status: v.union(
      v.literal("stored"),
      v.literal("expired"),
      v.literal("deleted"),
    ),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_verificationId", ["verificationId"])
    .index("by_submissionId", ["submissionId"])
    .index("by_bountyId_and_createdAt", ["bountyId", "createdAt"])
    .index("by_expiresAt", ["expiresAt"]),

  verificationLogs: defineTable({
    verificationId: v.id("verifications"),
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
    agentId: v.optional(v.id("users")),
    claimId: v.optional(v.id("bountyClaims")),
    source: v.union(
      v.literal("verification_result_callback"),
      v.literal("verification_lifecycle"),
      v.literal("verification_timeout"),
      v.literal("system")
    ),
    level: v.union(
      v.literal("info"),
      v.literal("warning"),
      v.literal("error")
    ),
    eventType: v.string(),
    gate: v.optional(v.string()),
    visibility: v.optional(v.union(v.literal("public"), v.literal("hidden"))),
    message: v.string(),
    detailsJson: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_verificationId_and_createdAt", ["verificationId", "createdAt"])
    .index("by_submissionId_and_createdAt", ["submissionId", "createdAt"])
    .index("by_bountyId_and_createdAt", ["bountyId", "createdAt"])
    .index("by_agentId_and_createdAt", ["agentId", "createdAt"])
    .index("by_source_and_createdAt", ["source", "createdAt"])
    .index("by_eventType_and_createdAt", ["eventType", "createdAt"])
    .index("by_level_and_createdAt", ["level", "createdAt"]),

  mcpAuditLogs: defineTable({
    source: v.string(),
    level: v.union(
      v.literal("info"),
      v.literal("warning"),
      v.literal("error")
    ),
    eventType: v.string(),
    message: v.string(),
    requestId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    bountyId: v.optional(v.string()),
    claimId: v.optional(v.string()),
    submissionId: v.optional(v.string()),
    verificationId: v.optional(v.string()),
    workspaceId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    path: v.optional(v.string()),
    method: v.optional(v.string()),
    statusCode: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    detailsJson: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_agentId_and_createdAt", ["agentId", "createdAt"])
    .index("by_bountyId_and_createdAt", ["bountyId", "createdAt"])
    .index("by_claimId_and_createdAt", ["claimId", "createdAt"])
    .index("by_submissionId_and_createdAt", ["submissionId", "createdAt"])
    .index("by_verificationId_and_createdAt", ["verificationId", "createdAt"])
    .index("by_workspaceId_and_createdAt", ["workspaceId", "createdAt"])
    .index("by_requestId_and_createdAt", ["requestId", "createdAt"])
    .index("by_eventType_and_createdAt", ["eventType", "createdAt"])
    .index("by_level_and_createdAt", ["level", "createdAt"]),

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
    provider: v.optional(repoProviderValidator),
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
    webhookStatus: v.optional(
      v.union(
        v.literal("unconfigured"),
        v.literal("active"),
        v.literal("failing"),
        v.literal("disabled"),
      ),
    ),
    providerAccountId: v.optional(v.string()),
    providerAccountName: v.optional(v.string()),
    externalRepoId: v.optional(v.string()),
    authMode: v.optional(
      v.union(
        v.literal("github_app"),
        v.literal("oauth"),
        v.literal("api_token"),
        v.literal("app_password"),
        v.literal("none"),
      ),
    ),
    tokenRef: v.optional(v.string()),
    capabilities: v.optional(v.object({
      supportsWebhookPush: v.boolean(),
      supportsNativePr: v.boolean(),
      supportsAutoBranchWrite: v.boolean(),
    })),
    lastSeenCommit: v.optional(v.string()),
    lastWebhookEventAt: v.optional(v.number()),
    githubInstallationId: v.optional(v.number()),
    githubInstallationAccountLogin: v.optional(v.string()),
    detectedFeatureFiles: v.optional(v.array(v.object({
      filePath: v.string(),
      content: v.string(),
    }))),
  })
    .index("by_bountyId", ["bountyId"])
    .index("by_status", ["status"])
    .index("by_owner_and_repo", ["owner", "repo"]),

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
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_bountyId", ["bountyId"])
    .index("by_repoConnectionId", ["repoConnectionId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["bountyId"],
    }),

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
    workerHostUsed: v.optional(v.string()),
    attemptWorkerId: v.optional(v.id("attemptWorkers")),
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

  mcpRegistrationLimits: defineTable({
    key: v.string(),
    windowStartMs: v.number(),
    count: v.number(),
    expiresAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_key_and_windowStartMs", ["key", "windowStartMs"])
    .index("by_expiresAt", ["expiresAt"]),

  workerCallbackNonces: defineTable({
    nonce: v.string(),
    verificationId: v.id("verifications"),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_nonce", ["nonce"])
    .index("by_expiresAt", ["expiresAt"]),

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
    apiTokenEncrypted: v.optional(v.string()),
    oauthAccessToken: v.optional(v.string()),
    oauthRefreshToken: v.optional(v.string()),
    oauthExpiresAt: v.optional(v.number()),
    status: v.union(v.literal("active"), v.literal("revoked")),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_and_status", ["userId", "status"])
    .index("by_userId_and_provider", ["userId", "provider"]),

  providerConnections: defineTable({
    userId: v.id("users"),
    provider: v.union(
      v.literal("github"),
      v.literal("gitlab"),
      v.literal("bitbucket"),
      v.literal("jira"),
      v.literal("linear"),
    ),
    accountId: v.optional(v.string()),
    accountName: v.optional(v.string()),
    domain: v.optional(v.string()),
    accessTokenEncrypted: v.string(),
    refreshTokenEncrypted: v.optional(v.string()),
    tokenType: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    scope: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("revoked")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_and_provider", ["userId", "provider"])
    .index("by_userId_and_provider_and_status", ["userId", "provider", "status"]),

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
    provider: v.optional(repoProviderValidator),
    owner: v.string(),
    repo: v.string(),
    languages: v.optional(v.array(v.string())),
    hidden: v.optional(v.boolean()),
    lastUsedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_and_repositoryUrl", ["userId", "repositoryUrl"]),

  repoContextFiles: defineTable({
    repoKey: v.string(),
    repositoryUrlCanonical: v.string(),
    uploadedByUserId: v.id("users"),
    filenameOriginal: v.string(),
    filenameSafe: v.string(),
    extension: v.string(),
    contentType: v.string(),
    bytes: v.number(),
    sha256: v.string(),
    storageId: v.id("_storage"),
    extractionStatus: v.union(
      v.literal("processing"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    extractedText: v.optional(v.string()),
    extractionError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_repoKey", ["repoKey"])
    .index("by_repoKey_and_extractionStatus", ["repoKey", "extractionStatus"])
    .index("by_uploadedByUserId", ["uploadedByUserId"]),

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
    paidBountiesCompleted: v.optional(v.number()),
    paidPayoutVolumeUsd: v.optional(v.number()),
    totalSubmissions: v.number(),
    totalFirstAttemptPasses: v.number(),
    totalGateWarnings: v.number(),
    totalGatePasses: v.number(),
    avgTimeToResolutionMs: v.number(),
    avgSubmissionsPerBounty: v.number(),
    firstAttemptPassRate: v.number(),
    completionRate: v.number(),
    gateQualityScore: v.number(),
    sonarRiskBurden: v.optional(v.number()),
    snykMinorBurden: v.optional(v.number()),
    advisoryProcessFailureRate: v.optional(v.number()),
    sonarRiskDisciplineScore: v.optional(v.number()),
    snykMinorDisciplineScore: v.optional(v.number()),
    advisoryReliabilityScore: v.optional(v.number()),
    avgCreatorRating: v.number(),
    totalRatings: v.number(),
    uniqueRaters: v.number(),
    trustedUniqueRaters: v.optional(v.number()),
    singleCreatorConcentration: v.number(),
    lowTrustCreatorShare: v.optional(v.number()),
    repeatCreatorHireRate: v.optional(v.number()),
    highValueCompletionRate: v.optional(v.number()),
    hiddenPassRate: v.optional(v.number()),
    gamingRiskScore: v.optional(v.number()),
    weightedScore: v.optional(v.number()),
    penaltyScore: v.optional(v.number()),
    finalScore: v.optional(v.number()),
    promotionFreezeUntilMs: v.optional(v.number()),
    scoreVersion: v.optional(v.string()),
    scoreBreakdownJson: v.optional(v.string()),
    riskFlagsJson: v.optional(v.string()),
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
    attemptWorkerId: v.optional(v.id("attemptWorkers")),
    attemptMode: v.optional(v.union(
      v.literal("shared_worker"),
      v.literal("dedicated_attempt_vm"),
    )),
    attemptLaunchMs: v.optional(v.number()),
    attemptReadyMs: v.optional(v.number()),
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
      v.literal("agent_rated"),
      v.literal("agent_registered")
    ),
    bountyId: v.optional(v.id("bounties")),
    bountyTitle: v.optional(v.string()),
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

  agentHellos: defineTable({
    bountyId: v.id("bounties"),
    submissionId: v.id("submissions"),
    verificationId: v.id("verifications"),
    agentId: v.id("users"),
    agentIdentifier: v.string(),
    message: v.string(),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_agentId", ["agentId"])
    .index("by_bountyId", ["bountyId"]),

  stripeHandshakeChecks: defineTable({
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
    verificationId: v.id("verifications"),
    status: v.union(v.literal("passed"), v.literal("failed")),
    connectAccountId: v.optional(v.string()),
    payoutsEnabled: v.optional(v.boolean()),
    chargesEnabled: v.optional(v.boolean()),
    currentlyDueCount: v.optional(v.number()),
    ready: v.boolean(),
    message: v.string(),
    checkedAt: v.number(),
  })
    .index("by_bountyId", ["bountyId"])
    .index("by_agentId", ["agentId"])
    .index("by_verificationId", ["verificationId"])
    .index("by_checkedAt", ["checkedAt"]),

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

  attemptWorkers: defineTable({
    claimId: v.id("bountyClaims"),
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
    workspaceId: v.string(),
    instanceId: v.optional(v.string()),
    publicHost: v.optional(v.string()),
    status: v.union(
      v.literal("launching"),
      v.literal("running"),
      v.literal("healthy"),
      v.literal("ready"),
      v.literal("terminating"),
      v.literal("terminated"),
      v.literal("error"),
    ),
    launchRequestedAt: v.number(),
    runningAt: v.optional(v.number()),
    healthyAt: v.optional(v.number()),
    terminatedAt: v.optional(v.number()),
    terminateReason: v.optional(v.string()),
    bootLogRef: v.optional(v.string()),
    serviceTokenHash: v.string(),
    tokenSigningKeyId: v.string(),
    mode: v.union(
      v.literal("shared_worker"),
      v.literal("dedicated_attempt_vm"),
    ),
    errorMessage: v.optional(v.string()),
  })
    .index("by_claimId", ["claimId"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_instanceId", ["instanceId"])
    .index("by_bountyId", ["bountyId"])
    .index("by_status", ["status"]),
});
