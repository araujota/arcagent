import { internalAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  findGitHubInstallationForRepo,
  isGitHubAppConfigured,
  resolveGitHubTokenForRepo,
} from "./lib/githubApp";
import { verifyBddStepCoverage } from "./lib/bddStepVerifier";
import { PLATFORM_TERMS_VERSION } from "../shared/legal";

const DEFAULT_REPOSITORY_URL = "https://github.com/araujota/arcagent";
const DEFAULT_BRANCH = "main";

const PUBLIC_GHERKIN = `Feature: Agent Hello Onboarding

  Scenario: Add the agenthellos page
    Given the agenthellos route exists
    Then the agenthellos page is a TypeScript route file
    And the page contains hello from text with the agent identifier
    And the page imports at least one existing UI component library
    And the page stores hello entries in local client code`;

const HIDDEN_GHERKIN = `Feature: Agent Hello Hidden Checks

  Scenario: Add sidebar navigation for the page
    Given the app sidebar exists
    Then the sidebar includes a navigation link to /agenthellos

  Scenario: Keep the page client-rendered
    Given the agenthellos route exists
    Then the agenthellos page is client only
    And the agenthellos page does not import convex client APIs
    And the agenthellos page does not read agent hellos from convex`;

const PUBLIC_STEP_DEFS = JSON.stringify([
  {
    path: "agenthellos.public.steps.js",
    content: [
      "const { Given, Then } = require('@cucumber/cucumber');",
      "const fs = require('fs');",
      "const assert = require('assert');",
      "",
      "const PAGE = 'src/app/(dashboard)/agenthellos/page.tsx';",
      "",
      "Given('the agenthellos route exists', function () {",
      "  assert.ok(fs.existsSync(PAGE), `Missing route: ${PAGE}`);",
      "});",
      "",
      "Then('the agenthellos page is a TypeScript route file', function () {",
      "  assert.ok(PAGE.endsWith('.tsx'), 'Expected page.tsx route');",
      "});",
      "",
      "Then('the page contains hello from text with the agent identifier', function () {",
      "  const content = fs.readFileSync(PAGE, 'utf-8');",
      "  assert.match(content, /hello from/i, 'Expected \\\"hello from\\\" text');",
      "  assert.match(content, /(agentIdentifier|userId)/, 'Expected a unique agent identifier reference');",
      "});",
      "",
      "Then('the page imports at least one existing UI component library', function () {",
      "  const content = fs.readFileSync(PAGE, 'utf-8');",
      "  assert.match(content, /@\\/components\\/ui\\//, 'Expected import from existing UI library');",
      "});",
      "",
      "Then('the page stores hello entries in local client code', function () {",
      "  const content = fs.readFileSync(PAGE, 'utf-8');",
      "  assert.match(content, /(AGENT_HELLOS|agentHellos)/, 'Expected local hello entries in page code');",
      "});",
      "",
    ].join('\\n'),
  },
]);

const HIDDEN_STEP_DEFS = JSON.stringify([
  {
    path: "agenthellos.hidden.steps.js",
    content: [
      "const { Given, Then } = require('@cucumber/cucumber');",
      "const fs = require('fs');",
      "const assert = require('assert');",
      "",
      "const PAGE = 'src/app/(dashboard)/agenthellos/page.tsx';",
      "const SIDEBAR = 'src/components/layout/app-sidebar.tsx';",
      "",
      "Given('the app sidebar exists', function () {",
      "  assert.ok(fs.existsSync(SIDEBAR), `Missing sidebar: ${SIDEBAR}`);",
      "});",
      "",
      "Then(/the sidebar includes a navigation link to \\/agenthellos/, function () {",
      "  const content = fs.readFileSync(SIDEBAR, 'utf-8');",
      "  assert.match(content, /\\/agenthellos/, 'Expected /agenthellos navigation link');",
      "});",
      "",
      "Given('the agenthellos route exists', function () {",
      "  assert.ok(fs.existsSync(PAGE), `Missing route: ${PAGE}`);",
      "});",
      "",
      "Then('the agenthellos page is client only', function () {",
      "  const content = fs.readFileSync(PAGE, 'utf-8');",
      "  assert.match(content, /['\\\"]use client['\\\"]/i, 'Expected client component page');",
      "  assert.ok(!/use server/i.test(content), 'Page should not be a server action file');",
      "});",
      "",
      "Then('the agenthellos page does not import convex client APIs', function () {",
      "  const content = fs.readFileSync(PAGE, 'utf-8');",
      "  assert.ok(!/from ['\\\"]convex\\/react['\\\"]/.test(content), 'Expected no convex/react import on page');",
      "  assert.ok(!/convex\\/_generated\\/api/.test(content), 'Expected no generated convex api import on page');",
      "  assert.ok(!/useProductAnalytics/.test(content), 'Expected no analytics hook that depends on Convex');",
      "});",
      "",
      "Then('the agenthellos page does not read agent hellos from convex', function () {",
      "  const content = fs.readFileSync(PAGE, 'utf-8');",
      "  assert.ok(!/useQuery\\s*\\(/.test(content), 'Expected no useQuery hook on page');",
      "  assert.ok(!/agentHellos\\.listRecent/.test(content), 'Expected no agentHellos list query on page');",
      "  assert.ok(!/api\\.agentHellos/.test(content), 'Expected no api.agentHellos usage on page');",
      "});",
      "",
    ].join('\\n'),
  },
]);

function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function parseCommitShaFromBody(textBody: string): string | null {
  const payload = safeParseJson(textBody) as { sha?: string };
  if (!payload.sha) return null;
  return payload.sha;
}

function parseRateLimitResetIso(rateLimitReset: string | null): string | null {
  if (!rateLimitReset || !/^\d+$/.test(rateLimitReset)) return null;
  return new Date(Number.parseInt(rateLimitReset, 10) * 1000).toISOString();
}

function buildCommitResolveError(response: Response, textBody: string, token: string | undefined): Error {
  const githubMessage = extractGitHubErrorMessage(textBody);
  const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
  const rateLimitReset = response.headers.get("x-ratelimit-reset");
  const rateLimitResetIso = parseRateLimitResetIso(rateLimitReset);
  const remediation =
    "Set TEST_BOUNTY_COMMIT_SHA to a known-good commit, install the Arcagent GitHub App on the repository, or configure GITHUB_API_TOKEN for authenticated API access.";
  const details = [
    `status=${response.status}`,
    githubMessage ? `githubMessage=${githubMessage}` : null,
    `rateLimitRemaining=${rateLimitRemaining ?? "unknown"}`,
    `rateLimitReset=${rateLimitResetIso ?? rateLimitReset ?? "unknown"}`,
    `authMode=${token ? "authenticated" : "unauthenticated"}`,
  ].filter(Boolean).join(", ");
  return new Error(`Failed to resolve test bounty commit SHA (${details}). ${remediation}`);
}

function shouldRetryCommitResolution(status: number, attempt: number, maxAttempts: number): boolean {
  return attempt < maxAttempts && (status === 403 || status === 429 || status >= 500);
}

async function resolveCommitSha(repositoryUrl: string, branch: string): Promise<string> {
  if (process.env.TEST_BOUNTY_COMMIT_SHA) {
    return process.env.TEST_BOUNTY_COMMIT_SHA;
  }

  const parsed = parseGitHubRepo(repositoryUrl);
  if (!parsed) {
    throw new Error("TEST_BOUNTY_COMMIT_SHA is required for non-GitHub repository URLs");
  }

  const appToken = await resolveGitHubTokenForRepo({
    repositoryUrl,
    writeAccess: false,
  });
  const token = appToken?.token ?? process.env.GITHUB_API_TOKEN?.trim();
  const endpoint = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(branch)}`;
  const maxAttempts = 3;
  const baseRetryDelayMs = 200;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "arcagent",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    const textBody = await response.text();
    if (response.ok) {
      const sha = parseCommitShaFromBody(textBody);
      if (!sha) {
        throw new Error("GitHub commit response did not include sha");
      }
      return sha;
    }

    lastError = buildCommitResolveError(response, textBody, token);
    if (!shouldRetryCommitResolution(response.status, attempt, maxAttempts)) {
      break;
    }
    await sleep(baseRetryDelayMs * attempt);
  }

  throw lastError ?? new Error("Failed to resolve test bounty commit SHA");
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function extractGitHubErrorMessage(body: string): string | null {
  const parsed = safeParseJson(body) as { message?: string };
  if (typeof parsed.message === "string" && parsed.message.trim()) {
    return parsed.message.trim();
  }
  const compact = body.trim().replace(/\s+/g, " ");
  return compact ? compact.slice(0, 240) : null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export const ensureTestCreator = internalMutation({
  args: {},
  handler: async (ctx) => {
    const email = process.env.TEST_BOUNTY_CREATOR_EMAIL ?? "testbounty-creator@arcagent.local";
    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    if (existing) {
      return existing._id;
    }

    return await ctx.db.insert("users", {
      clerkId: process.env.TEST_BOUNTY_CREATOR_CLERK_ID ?? "test_bounty_creator",
      name: process.env.TEST_BOUNTY_CREATOR_NAME ?? "Arcagent Test Bounty Creator",
      email,
      role: "creator",
      onboardingComplete: true,
      onboardingStep: 5,
      hasPaymentMethod: true,
    });
  },
});

export const createArtifacts = internalMutation({
  args: {
    creatorId: v.id("users"),
    agentIdentifier: v.string(),
    repositoryUrl: v.string(),
    owner: v.string(),
    repo: v.string(),
    defaultBranch: v.string(),
    commitSha: v.string(),
    githubInstallationId: v.number(),
    githubInstallationAccountLogin: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const staticTemplateVerification = verifyBddStepCoverage({
      gherkinPublic: PUBLIC_GHERKIN,
      gherkinHidden: HIDDEN_GHERKIN,
      stepDefinitionPayloads: [
        { label: "public", serialized: PUBLIC_STEP_DEFS },
        { label: "hidden", serialized: HIDDEN_STEP_DEFS },
      ],
    });
    if (!staticTemplateVerification.valid) {
      throw new Error(
        `Test bounty Gherkin/step templates failed verification: ${staticTemplateVerification.issues
          .slice(0, 5)
          .join("; ")}`,
      );
    }

    const bountyId = await ctx.db.insert("bounties", {
      title: `Test Bounty: Agent Hello (${args.agentIdentifier})`,
      description:
        "Onboarding test bounty: keep /agenthellos as a client-code-only hello feed (no Convex reads) with a unique agent identifier.",
      creatorId: args.creatorId,
      status: "active",
      reward: 25,
      rewardCurrency: "USD",
      paymentMethod: "stripe",
      escrowStatus: "funded",
      repositoryUrl: args.repositoryUrl,
      tags: ["testbounty", "onboarding", "typescript"],
      tosAccepted: true,
      tosAcceptedAt: Date.now(),
      tosVersion: PLATFORM_TERMS_VERSION,
      claimDurationHours: 4,
      isTestBounty: true,
      testBountyKind: "agenthello_v1",
      testBountyAgentIdentifier: args.agentIdentifier,
    });

    const repoConnectionId = await ctx.db.insert("repoConnections", {
      bountyId,
      repositoryUrl: args.repositoryUrl,
      provider: "github",
      owner: args.owner,
      repo: args.repo,
      defaultBranch: args.defaultBranch,
      trackedBranch: args.defaultBranch,
      commitSha: args.commitSha,
      status: "ready",
      totalFiles: 0,
      totalSymbols: 0,
      languages: ["typescript"],
      lastIndexedAt: Date.now(),
      dockerfilePath: "Dockerfile",
      dockerfileSource: "repo",
      githubInstallationId: args.githubInstallationId,
      githubInstallationAccountLogin: args.githubInstallationAccountLogin,
    });

    await ctx.db.patch(bountyId, { repoConnectionId });

    await ctx.db.insert("testSuites", {
      bountyId,
      title: "Agent Hello - Public",
      version: 1,
      gherkinContent: PUBLIC_GHERKIN,
      visibility: "public",
      source: "generated",
    });

    await ctx.db.insert("testSuites", {
      bountyId,
      title: "Agent Hello - Hidden",
      version: 2,
      gherkinContent: HIDDEN_GHERKIN,
      visibility: "hidden",
      source: "generated",
    });

    const conversationId = await ctx.db.insert("conversations", {
      bountyId,
      status: "finalized",
      messages: [],
      autonomous: true,
    });

    await ctx.db.insert("generatedTests", {
      bountyId,
      conversationId,
      version: 1,
      gherkinPublic: PUBLIC_GHERKIN,
      gherkinHidden: HIDDEN_GHERKIN,
      stepDefinitions: PUBLIC_STEP_DEFS,
      stepDefinitionsPublic: PUBLIC_STEP_DEFS,
      stepDefinitionsHidden: HIDDEN_STEP_DEFS,
      testFramework: "cucumber",
      testLanguage: "javascript",
      status: "published",
      llmModel: "testbounty-static",
    });

    return { bountyId };
  },
});

export const createAndClaim = internalAction({
  args: {
    agentId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const repositoryUrl = process.env.TEST_BOUNTY_REPOSITORY_URL ?? DEFAULT_REPOSITORY_URL;
    const defaultBranch = process.env.TEST_BOUNTY_DEFAULT_BRANCH ?? DEFAULT_BRANCH;

    const parsed = parseGitHubRepo(repositoryUrl);
    if (!parsed) {
      throw new Error("TEST_BOUNTY_REPOSITORY_URL must be a GitHub repo URL");
    }
    if (!isGitHubAppConfigured()) {
      throw new Error(
        "GitHub App is not configured in this environment. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY before creating test bounties."
      );
    }

    const installation = await findGitHubInstallationForRepo(parsed.owner, parsed.repo);
    if (!installation) {
      throw new Error(
        "GitHub App installation is required for TEST_BOUNTY_REPOSITORY_URL. Install the Arcagent GitHub App on the repo or owning organization."
      );
    }

    const commitSha = await resolveCommitSha(repositoryUrl, defaultBranch);
    const creatorId = await ctx.runMutation(internal.testBounties.ensureTestCreator, {});

    const { bountyId } = await ctx.runMutation(internal.testBounties.createArtifacts, {
      creatorId,
      agentIdentifier: String(args.agentId),
      repositoryUrl,
      owner: parsed.owner,
      repo: parsed.repo,
      defaultBranch,
      commitSha,
      githubInstallationId: installation.installationId,
      githubInstallationAccountLogin: installation.accountLogin,
    });

    const claimId = await ctx.runMutation(internal.bountyClaims.create, {
      bountyId,
      agentId: args.agentId,
    });

    return {
      bountyId,
      claimId,
      repositoryUrl,
      commitSha,
      testBountyKind: "agenthello_v1",
      message:
        "Test bounty created and claimed. Use workspace_status and complete the /agenthellos task, then submit_solution.",
    };
  },
});
