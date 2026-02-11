import { mutation } from "./_generated/server";

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    // Check if already seeded
    const existingUsers = await ctx.db.query("users").collect();
    if (existingUsers.length > 0) {
      console.log("Database already has data, skipping seed");
      return;
    }

    // Create sample users
    const creatorId = await ctx.db.insert("users", {
      clerkId: "seed_creator_001",
      name: "Alice Chen",
      email: "alice@example.com",
      role: "creator",
      avatarUrl: undefined,
    });

    const agentId = await ctx.db.insert("users", {
      clerkId: "seed_agent_001",
      name: "Bob Smith",
      email: "bob@example.com",
      role: "agent",
      avatarUrl: undefined,
    });

    const adminId = await ctx.db.insert("users", {
      clerkId: "seed_admin_001",
      name: "Carol Admin",
      email: "carol@example.com",
      role: "admin",
      avatarUrl: undefined,
    });

    // Create sample bounties
    const bounty1 = await ctx.db.insert("bounties", {
      title: "Build a REST API rate limiter",
      description:
        "Implement a token bucket rate limiter middleware for Express.js that supports per-user and per-endpoint limits. Must handle distributed environments using Redis.",
      creatorId,
      status: "active",
      reward: 500,
      rewardCurrency: "USD",
      paymentMethod: "stripe",
      deadline: Date.now() + 7 * 24 * 60 * 60 * 1000,
      tags: ["typescript", "express", "redis", "middleware"],
    });

    const bounty2 = await ctx.db.insert("bounties", {
      title: "CSV Parser with streaming support",
      description:
        "Create a high-performance CSV parser that handles streaming input, quoted fields, custom delimiters, and provides both sync and async APIs.",
      creatorId,
      status: "active",
      reward: 300,
      rewardCurrency: "USD",
      paymentMethod: "stripe",
      tags: ["typescript", "parsing", "streams"],
    });

    const bounty3 = await ctx.db.insert("bounties", {
      title: "Smart contract for escrow payments",
      description:
        "Write a Solidity escrow contract that holds funds until verification passes. Must support ERC-20 tokens and have emergency withdrawal mechanisms.",
      creatorId,
      status: "draft",
      reward: 0.5,
      rewardCurrency: "ETH",
      paymentMethod: "web3",
      tags: ["solidity", "ethereum", "defi"],
    });

    const bounty4 = await ctx.db.insert("bounties", {
      title: "React component testing library",
      description:
        "Build a lightweight testing utility for React components that provides better ergonomics than existing solutions. Should support hooks testing and async operations.",
      creatorId: adminId,
      status: "in_progress",
      reward: 750,
      rewardCurrency: "USD",
      paymentMethod: "stripe",
      deadline: Date.now() + 14 * 24 * 60 * 60 * 1000,
      tags: ["react", "testing", "typescript"],
    });

    const bounty5 = await ctx.db.insert("bounties", {
      title: "CLI tool for database migrations",
      description:
        "Create a database migration CLI tool supporting PostgreSQL and MySQL. Must handle up/down migrations, seed data, and generate TypeScript types from schema.",
      creatorId,
      status: "completed",
      reward: 600,
      rewardCurrency: "USD",
      paymentMethod: "stripe",
      tags: ["cli", "database", "migrations", "typescript"],
    });

    // Create test suites
    await ctx.db.insert("testSuites", {
      bountyId: bounty1,
      title: "Rate Limiter - Public Tests",
      version: 1,
      visibility: "public",
      gherkinContent: `Feature: Token Bucket Rate Limiter

  Scenario: Allow requests within rate limit
    Given a rate limiter configured with 10 requests per minute
    When a user makes 5 requests within 1 minute
    Then all requests should be allowed
    And the response should include remaining quota headers

  Scenario: Block requests exceeding rate limit
    Given a rate limiter configured with 10 requests per minute
    When a user makes 15 requests within 1 minute
    Then the first 10 requests should be allowed
    And the remaining 5 requests should return 429 Too Many Requests

  Scenario: Rate limit resets after window
    Given a rate limiter configured with 10 requests per minute
    When a user exhausts their rate limit
    And waits for the rate limit window to reset
    Then new requests should be allowed`,
    });

    await ctx.db.insert("testSuites", {
      bountyId: bounty1,
      title: "Rate Limiter - Hidden Tests",
      version: 1,
      visibility: "hidden",
      gherkinContent: `Feature: Rate Limiter Edge Cases

  Scenario: Per-endpoint rate limiting
    Given separate rate limits for "/api/search" (5/min) and "/api/data" (20/min)
    When a user makes 6 requests to "/api/search"
    Then the 6th request to "/api/search" should be blocked
    But requests to "/api/data" should still be allowed

  Scenario: Distributed rate limiting with Redis
    Given two application instances sharing a Redis backend
    When instance A records 5 requests and instance B records 5 requests
    Then the combined count should be 10
    And the 11th request from either instance should be blocked`,
    });

    await ctx.db.insert("testSuites", {
      bountyId: bounty2,
      title: "CSV Parser - Public Tests",
      version: 1,
      visibility: "public",
      gherkinContent: `Feature: CSV Parsing

  Scenario: Parse simple CSV
    Given a CSV string "name,age\\nAlice,30\\nBob,25"
    When the CSV is parsed
    Then it should return 2 rows
    And the first row should have name "Alice" and age "30"

  Scenario: Handle quoted fields
    Given a CSV string with quoted fields containing commas
    When the CSV is parsed
    Then quoted commas should not be treated as delimiters

  Scenario: Streaming large files
    Given a CSV file with 1 million rows
    When parsed using the streaming API
    Then memory usage should stay below 50MB
    And all rows should be processed correctly`,
    });

    // Create sample submissions
    const submission1 = await ctx.db.insert("submissions", {
      bountyId: bounty1,
      agentId: agentId,
      repositoryUrl: "https://github.com/bob/rate-limiter-solution",
      commitHash: "abc123def456",
      status: "passed",
      description: "Token bucket implementation with Redis adapter",
    });

    const submission2 = await ctx.db.insert("submissions", {
      bountyId: bounty4,
      agentId: agentId,
      repositoryUrl: "https://github.com/bob/react-test-utils",
      commitHash: "789ghi012jkl",
      status: "running",
      description: "Lightweight React testing utilities with hooks support",
    });

    // Create verification for passed submission
    const verification1 = await ctx.db.insert("verifications", {
      submissionId: submission1,
      bountyId: bounty1,
      status: "passed",
      result: "All tests passed",
      startedAt: Date.now() - 120000,
      completedAt: Date.now() - 60000,
      timeoutSeconds: 300,
    });

    // Create verification for running submission
    const verification2 = await ctx.db.insert("verifications", {
      submissionId: submission2,
      bountyId: bounty4,
      status: "running",
      startedAt: Date.now() - 30000,
      timeoutSeconds: 300,
    });

    // Record sanity gates for passed verification
    await ctx.db.insert("sanityGates", {
      verificationId: verification1,
      gateType: "lint",
      tool: "eslint",
      status: "passed",
    });

    await ctx.db.insert("sanityGates", {
      verificationId: verification1,
      gateType: "typecheck",
      tool: "tsc",
      status: "passed",
    });

    await ctx.db.insert("sanityGates", {
      verificationId: verification1,
      gateType: "security",
      tool: "npm audit",
      status: "warning",
      issues: ["1 low severity vulnerability in dev dependencies"],
    });

    // Record verification steps
    await ctx.db.insert("verificationSteps", {
      verificationId: verification1,
      featureName: "Token Bucket Rate Limiter",
      scenarioName: "Allow requests within rate limit",
      status: "pass",
      executionTimeMs: 245,
      output: "All assertions passed",
      stepNumber: 1,
    });

    await ctx.db.insert("verificationSteps", {
      verificationId: verification1,
      featureName: "Token Bucket Rate Limiter",
      scenarioName: "Block requests exceeding rate limit",
      status: "pass",
      executionTimeMs: 512,
      output: "Rate limiting correctly applied at threshold",
      stepNumber: 2,
    });

    await ctx.db.insert("verificationSteps", {
      verificationId: verification1,
      featureName: "Token Bucket Rate Limiter",
      scenarioName: "Rate limit resets after window",
      status: "pass",
      executionTimeMs: 1830,
      output: "Window reset verified after timeout period",
      stepNumber: 3,
    });

    await ctx.db.insert("verificationSteps", {
      verificationId: verification1,
      featureName: "Rate Limiter Edge Cases",
      scenarioName: "Per-endpoint rate limiting",
      status: "pass",
      executionTimeMs: 678,
      stepNumber: 4,
    });

    await ctx.db.insert("verificationSteps", {
      verificationId: verification1,
      featureName: "Rate Limiter Edge Cases",
      scenarioName: "Distributed rate limiting with Redis",
      status: "pass",
      executionTimeMs: 2100,
      output: "Redis-backed distributed counting verified",
      stepNumber: 5,
    });

    // Sanity gates for running verification
    await ctx.db.insert("sanityGates", {
      verificationId: verification2,
      gateType: "lint",
      tool: "eslint",
      status: "passed",
    });

    await ctx.db.insert("sanityGates", {
      verificationId: verification2,
      gateType: "typecheck",
      tool: "tsc",
      status: "passed",
    });

    // Create payment for completed bounty
    await ctx.db.insert("payments", {
      bountyId: bounty5,
      recipientId: agentId,
      amount: 600,
      currency: "USD",
      method: "stripe",
      status: "completed",
      transactionId: "pi_seed_123456",
      createdAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
    });

    console.log("Seed data created successfully");
    console.log({
      users: [creatorId, agentId, adminId],
      bounties: [bounty1, bounty2, bounty3, bounty4, bounty5],
      submissions: [submission1, submission2],
      verifications: [verification1, verification2],
    });
  },
});
