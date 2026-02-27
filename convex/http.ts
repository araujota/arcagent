import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { Webhook as SvixWebhook } from "svix";
import { constantTimeEqual } from "./lib/constantTimeEqual";
import {
  verifyJobHmac,
  verifyWorkerCallbackSignature,
  isFreshWorkerCallbackTimestamp,
} from "./lib/hmac";
import { deriveAttemptTokenSigningSecret } from "./lib/attemptWorkerAuth";

const http = httpRouter();

// ---------------------------------------------------------------------------
// Clerk Webhook (existing)
// ---------------------------------------------------------------------------

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const svixId = request.headers.get("svix-id");
    const svixTimestamp = request.headers.get("svix-timestamp");
    const svixSignature = request.headers.get("svix-signature");

    if (!svixId || !svixTimestamp || !svixSignature) {
      return new Response("Missing svix headers", { status: 400 });
    }

    const payload = await request.text();

    // Verify webhook signature using Svix
    const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("CLERK_WEBHOOK_SECRET not configured");
      return new Response("Webhook secret not configured", { status: 500 });
    }

    // Verify the webhook signature
    const wh = new SvixWebhook(webhookSecret);

    let event: {
      type: string;
      data: {
        id: string;
        first_name?: string;
        last_name?: string;
        username?: string;
        email_addresses?: Array<{ email_address: string }>;
        image_url?: string;
        external_accounts?: Array<{
          provider: string;
          username?: string;
        }>;
      };
    };

    try {
      event = wh.verify(payload, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      }) as typeof event;
    } catch {
      console.error("Webhook signature verification failed");
      return new Response("Invalid signature", { status: 400 });
    }

    const { type, data } = event;

    switch (type) {
      case "user.created":
      case "user.updated": {
        const name =
          [data.first_name, data.last_name].filter(Boolean).join(" ") ||
          "Unknown";
        const email = data.email_addresses?.[0]?.email_address ?? "";

        // Extract GitHub username from linked OAuth accounts
        const githubAccount = data.external_accounts?.find(
          (a) => a.provider === "oauth_github"
        );
        const githubUsername = githubAccount?.username ?? data.username;

        await ctx.runMutation(internal.users.upsertFromClerk, {
          clerkId: data.id,
          name,
          email,
          avatarUrl: data.image_url,
          githubUsername,
        });
        break;
      }
      case "user.deleted": {
        await ctx.runMutation(internal.users.deleteFromClerk, {
          clerkId: data.id,
        });
        break;
      }
      default:
        console.log(`Unhandled webhook event type: ${type}`);
    }

    return new Response("OK", { status: 200 });
  }),
});

// ---------------------------------------------------------------------------
// GitHub Push Webhook (re-indexing)
// ---------------------------------------------------------------------------

http.route({
  path: "/github-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("GITHUB_WEBHOOK_SECRET not configured");
      return new Response("Webhook secret not configured", { status: 500 });
    }

    const event = request.headers.get("x-github-event");
    const signatureHeader = request.headers.get("x-hub-signature-256");

    if (!signatureHeader) {
      return new Response("Missing signature", { status: 400 });
    }

    const payload = await request.text();

    // Verify HMAC-SHA256 signature
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payload)
    );
    const expectedSig =
      "sha256=" +
      Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    if (expectedSig.length !== signatureHeader.length) {
      return new Response("Invalid signature", { status: 401 });
    }
    // Constant-time comparison
    let mismatch = 0;
    for (let i = 0; i < expectedSig.length; i++) {
      mismatch |= expectedSig.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
    }
    if (mismatch !== 0) {
      return new Response("Invalid signature", { status: 401 });
    }

    // Handle ping event
    if (event === "ping") {
      return new Response("pong", { status: 200 });
    }

    // Handle push events
    if (event === "push") {
      let body: {
        ref: string;
        after: string;
        repository: { full_name: string };
      };
      try {
        body = JSON.parse(payload);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      // Extract branch from refs/heads/<branch>
      const branchMatch = body.ref.match(/^refs\/heads\/(.+)$/);
      if (!branchMatch) {
        return new Response("Not a branch push", { status: 200 });
      }
      const branch = branchMatch[1];
      const newSha = body.after;
      const [owner, repo] = body.repository.full_name.split("/");

      // Find matching repo connections
      const readyConnections = await ctx.runQuery(
        internal.repoConnections.listReady
      );

      for (const conn of readyConnections) {
        const trackedBranch = conn.trackedBranch || conn.defaultBranch;
        if (
          conn.owner === owner &&
          conn.repo === repo &&
          trackedBranch === branch &&
          conn.commitSha !== newSha
        ) {
          await ctx.runMutation(internal.repoConnections.triggerReIndex, {
            repoConnectionId: conn._id,
            newCommitSha: newSha,
          });
        }
      }

      return new Response("OK", { status: 200 });
    }

    return new Response("Unhandled event", { status: 200 });
  }),
});

// ---------------------------------------------------------------------------
// MCP Internal Endpoints (shared-secret auth)
// ---------------------------------------------------------------------------

// constantTimeEqual imported from ./lib/constantTimeEqual

function verifyMcpSecret(request: Request): boolean {
  const secret = process.env.MCP_SHARED_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;

  const token = header.slice("Bearer ".length);
  return constantTimeEqual(token, secret);
}

// ---------------------------------------------------------------------------
// Dual auth: shared secret (self-hosted) OR API key (npx users)
// ---------------------------------------------------------------------------

interface McpAuthResult {
  authenticated: boolean;
  userId?: string;
  authMethod: "shared_secret" | "api_key" | "none";
}

const WORKSPACE_AGENT_TOKEN_AUDIENCE = "arcagent-worker-workspace";
const WORKSPACE_AGENT_TOKEN_ISSUER = "arcagent-convex";
const WORKSPACE_AGENT_TOKEN_TTL_SECONDS = 60;

const ALLOWED_WORKSPACE_ROUTE_PATHS = new Set<string>([
  "/api/workspace/exec",
  "/api/workspace/read-file",
  "/api/workspace/write-file",
  "/api/workspace/diff",
  "/api/workspace/status",
  "/api/workspace/extend-ttl",
  "/api/workspace/batch-read",
  "/api/workspace/batch-write",
  "/api/workspace/search",
  "/api/workspace/list-files",
  "/api/workspace/exec-stream",
  "/api/workspace/exec-output",
  "/api/workspace/edit-file",
  "/api/workspace/glob",
  "/api/workspace/grep",
  "/api/workspace/session-exec",
]);

function toBase64Url(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function textToBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return toBase64Url(bytes);
}

async function signWorkspaceAgentToken(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = textToBase64Url(JSON.stringify(header));
  const encodedPayload = textToBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)),
  );
  const encodedSignature = toBase64Url(signature);
  return `${signingInput}.${encodedSignature}`;
}

async function verifyMcpAuth(
  ctx: { runQuery: Function; runMutation: Function },
  request: Request
): Promise<McpAuthResult> {
  // Fast path: shared secret (existing self-hosted mode)
  if (verifyMcpSecret(request)) {
    return { authenticated: true, authMethod: "shared_secret" };
  }

  // Slow path: API key bearer token (npx / external agent mode)
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer arc_")) {
    return { authenticated: false, authMethod: "none" };
  }

  const apiKey = header.slice("Bearer ".length);
  if (apiKey.length < 36 || apiKey.length > 52) {
    return { authenticated: false, authMethod: "none" };
  }

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(apiKey)
  );
  const keyHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const result = await ctx.runQuery(internal.apiKeys.validateByHash, {
    keyHash,
  });
  if (!result) return { authenticated: false, authMethod: "none" };

  await ctx.runMutation(internal.apiKeys.updateLastUsed, {
    apiKeyId: result.apiKeyId,
  });
  return {
    authenticated: true,
    userId: result.userId,
    authMethod: "api_key",
  };
}

function verifyWorkerSecret(request: Request): boolean {
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;

  const token = header.slice("Bearer ".length);
  return constantTimeEqual(token, secret);
}

function mcpUnauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function mcpError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mcpJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function isBountyCreator(
  ctx: { runQuery: Function },
  userId: string,
  bountyId: Id<"bounties">,
): Promise<boolean> {
  const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, { bountyId });
  return !!bounty && bounty.creatorId === userId;
}

// --- Auth: Validate API key ---
// Supports two paths:
// 1. Shared secret + keyHash in body (existing self-hosted mode)
// 2. Bearer arc_... token directly (npx mode — hashes server-side)
http.route({
  path: "/api/mcp/auth/validate",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Path 2: Direct API key bearer token (npx mode)
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer arc_")) {
      const auth = await verifyMcpAuth(ctx, request);
      if (!auth.authenticated || !auth.userId) {
        return mcpJson({ valid: false }, 200);
      }
      const user = await ctx.runQuery(internal.users.getByIdInternal, {
        userId: auth.userId as Id<"users">,
      });
      if (!user) return mcpJson({ valid: false }, 200);

      // Look up scopes from the API key
      const apiKey = authHeader.slice("Bearer ".length);
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(apiKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const keyResult = await ctx.runQuery(internal.apiKeys.validateByHash, { keyHash });

      return mcpJson({
        valid: true,
        userId: auth.userId,
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
        scopes: keyResult?.scopes ?? [],
      });
    }

    // Path 1: Shared secret + keyHash in body (existing self-hosted mode)
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { keyHash } = body as { keyHash: string };
    if (!keyHash) return mcpError("Missing keyHash");

    const result = await ctx.runQuery(internal.apiKeys.validateByHash, {
      keyHash,
    });

    if (!result) {
      return mcpJson({ valid: false }, 200);
    }

    // Update last used timestamp
    await ctx.runMutation(internal.apiKeys.updateLastUsed, {
      apiKeyId: result.apiKeyId,
    });

    return mcpJson({
      valid: true,
      userId: result.userId,
      user: {
        _id: result.user._id,
        name: result.user.name,
        email: result.user.email,
        role: result.user.role,
      },
      scopes: result.scopes,
    });
  }),
});

// --- Agents: Create/link agent user + API key ---
// Uses upsertFromClerk so MCP-registered agents share the same user record
// as web-registered users. The clerkId comes from a real Clerk user created
// by the MCP server via the Clerk Backend API.
http.route({
  path: "/api/mcp/agents/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const { name, email, clerkId, githubUsername } =
      body as {
        name: string;
        email: string;
        clerkId?: string;
        githubUsername?: string;
      };

    if (!name || !email) {
      return mcpError("Missing required fields: name and email");
    }

    try {
      // Convex-side registration throttling (IP + email + clerkId windows).
      const ip =
        request.headers.get("cf-connecting-ip") ||
        request.headers.get("x-real-ip") ||
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        "unknown";

      const limitsApi = internal as unknown as {
        mcpRegistrationLimits: { consume: unknown };
      };

      const ipLimit = await ctx.runMutation(limitsApi.mcpRegistrationLimits.consume as never, {
        key: `ip:${ip}`,
        maxRequests: 20,
        windowMs: 60_000,
      });
      if (!ipLimit.allowed) {
        return mcpJson(
          { error: "Registration rate limit exceeded", retryAfterMs: ipLimit.retryAfterMs },
          429,
        );
      }

      const normalizedEmail = email.trim().toLowerCase();
      const emailLimit = await ctx.runMutation(limitsApi.mcpRegistrationLimits.consume as never, {
        key: `email:${normalizedEmail}`,
        maxRequests: 5,
        windowMs: 60_000,
      });
      if (!emailLimit.allowed) {
        return mcpJson(
          { error: "Registration rate limit exceeded", retryAfterMs: emailLimit.retryAfterMs },
          429,
        );
      }

      const encoder = new TextEncoder();
      const syntheticHashBuffer = await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(normalizedEmail),
      );
      const syntheticHash = Array.from(new Uint8Array(syntheticHashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const resolvedClerkId = clerkId || `mcp_${syntheticHash.slice(0, 24)}`;

      const clerkLimit = await ctx.runMutation(limitsApi.mcpRegistrationLimits.consume as never, {
        key: `clerk:${resolvedClerkId}`,
        maxRequests: 5,
        windowMs: 60_000,
      });
      if (!clerkLimit.allowed) {
        return mcpJson(
          { error: "Registration rate limit exceeded", retryAfterMs: clerkLimit.retryAfterMs },
          429,
        );
      }

      // Upsert user via the same path as Clerk webhooks — unified accounts
      const userId = await ctx.runMutation(internal.users.upsertFromClerk, {
        clerkId: resolvedClerkId,
        name,
        email,
        githubUsername,
      });

      // Generate and hash API key in Convex so issuance is centrally indexed.
      const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const rawKey = `arc_${randomPart}`;
      const keyPrefix = rawKey.slice(0, 8);
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(rawKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      await ctx.runMutation(internal.apiKeys.create, {
        userId,
        keyHash,
        keyPrefix,
        name: `${name}'s API key`,
        scopes: ["bounties:read", "bounties:claim", "bounties:create", "submissions:write", "workspace:read", "workspace:write", "workspace:exec"],
      });

      await ctx.scheduler.runAfter(0, internal.activityFeed.record, {
        type: "agent_registered",
        actorName: name,
      });

      return mcpJson({ userId, apiKey: rawKey, keyPrefix });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create agent";
      return mcpError(message);
    }
  }),
});

// --- Bounties: List ---
http.route({
  path: "/api/mcp/bounties/list",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { status, tags, minReward, maxReward, search, limit } = body as {
      status?: string;
      tags?: string[];
      minReward?: number;
      maxReward?: number;
      search?: string;
      limit?: number;
    };

    const bounties = await ctx.runQuery(internal.bounties.listForMcp, {
      status,
      tags,
      minReward,
      maxReward,
      search,
      limit,
    });

    return mcpJson({ bounties });
  }),
});

// --- Bounties: Get details ---
http.route({
  path: "/api/mcp/bounties/get",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId } = body as { bountyId: string };
    if (!bountyId) return mcpError("Missing bountyId");

    const bounty = await ctx.runQuery(internal.bounties.getForMcp, {
      bountyId: bountyId as Id<"bounties">,
    });

    if (!bounty) return mcpError("Bounty not found", 404);
    return mcpJson({ bounty });
  }),
});

// --- Bounties: Create (MCP) ---
http.route({
  path: "/api/mcp/bounties/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const {
      creatorId: bodyCreatorId,
      title,
      description,
      reward,
      rewardCurrency,
      paymentMethod,
      deadline,
      tags,
      repositoryUrl,
      tosAccepted,
      tosAcceptedAt,
      tosVersion,
      pmIssueKey,
      pmProvider,
      pmConnectionId,
    } = body as {
      creatorId?: string;
      title: string;
      description: string;
      reward: number;
      rewardCurrency: string;
      paymentMethod: "stripe" | "web3";
      deadline?: number;
      tags?: string[];
      repositoryUrl?: string;
      tosAccepted?: boolean;
      tosAcceptedAt?: number;
      tosVersion?: string;
      pmIssueKey?: string;
      pmProvider?: "jira" | "linear" | "asana" | "monday";
      pmConnectionId?: string;
      requiredTier?: "S" | "A" | "B" | "C" | "D";
    };

    // SECURITY (C1): API key auth overrides creatorId from body
    const creatorId = auth.authMethod === "api_key" ? auth.userId! : bodyCreatorId;

    if (!creatorId || !title || !description || !reward || !rewardCurrency || !paymentMethod) {
      return mcpError("Missing required fields: creatorId, title, description, reward, rewardCurrency, paymentMethod");
    }

    try {
      const bountyId = await ctx.runMutation(internal.bounties.createFromMcp, {
        creatorId: creatorId as Id<"users">,
        title,
        description,
        reward,
        rewardCurrency,
        paymentMethod,
        deadline,
        tags,
        status: "draft",
        tosAccepted,
        tosAcceptedAt,
        tosVersion,
        pmIssueKey,
        pmProvider,
        pmConnectionId: pmConnectionId as Id<"pmConnections"> | undefined,
        requiredTier: body.requiredTier,
      });

      let repoConnectionId: string | null = null;
      let conversationId: string | null = null;

      if (repositoryUrl) {
        repoConnectionId = await ctx.runMutation(
          internal.repoConnections.createInternal,
          { bountyId, repositoryUrl }
        );

        conversationId = await ctx.runMutation(
          internal.conversations.createInternal,
          { bountyId, autonomous: true }
        );

        await ctx.scheduler.runAfter(
          0,
          internal.orchestrator.runAutonomousPipeline,
          {
            bountyId,
            repoConnectionId: repoConnectionId as Id<"repoConnections">,
            conversationId: conversationId as Id<"conversations">,
            repositoryUrl,
          }
        );
      }

      return mcpJson({
        bountyId,
        repoConnectionId,
        conversationId,
        status: "draft",
        nextStep: paymentMethod === "stripe"
          ? "Fund escrow, then publish bounty."
          : "Publish bounty when ready.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create bounty";
      return mcpError(message);
    }
  }),
});

// --- Test Bounty: Create + Claim (MCP) ---
http.route({
  path: "/api/mcp/testbounty/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { agentId: bodyAgentId } = body as { agentId?: string };
    const agentId = auth.authMethod === "api_key" ? auth.userId! : bodyAgentId;

    if (!agentId) {
      return mcpError("Missing required field: agentId");
    }

    try {
      const result = await ctx.runAction(internal.testBounties.createAndClaim, {
        agentId: agentId as Id<"users">,
      });

      return mcpJson(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create test bounty";
      return mcpError(message);
    }
  }),
});

// --- Bounties: Cancel ---
http.route({
  path: "/api/mcp/bounties/cancel",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId, creatorId: bodyCreatorId } = body as {
      bountyId: string;
      creatorId?: string;
    };

    // SECURITY (C1): API key auth overrides creatorId from body
    const creatorId = auth.authMethod === "api_key" ? auth.userId! : bodyCreatorId;

    if (!bountyId || !creatorId) {
      return mcpError("Missing required fields: bountyId, creatorId");
    }

    try {
      const result = await ctx.runMutation(internal.bounties.cancelFromMcp, {
        bountyId: bountyId as Id<"bounties">,
        creatorId: creatorId as Id<"users">,
      });

      return mcpJson(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to cancel bounty";
      return mcpError(message);
    }
  }),
});

// --- Bounties: Generation Status ---
http.route({
  path: "/api/mcp/bounties/generation-status",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId } = body as { bountyId: string };
    if (!bountyId) return mcpError("Missing bountyId");

    const typedBountyId = bountyId as Id<"bounties">;

    // Get repo connection status
    const repoConnection = await ctx.runQuery(
      internal.repoConnections.getByBountyIdInternal,
      { bountyId: typedBountyId }
    );

    // Get conversation status
    const conversation = await ctx.runQuery(
      internal.conversations.getByBountyIdInternal,
      { bountyId: typedBountyId }
    );

    // Get generated test status
    const generatedTest = await ctx.runQuery(
      internal.generatedTests.getByBountyIdInternal,
      { bountyId: typedBountyId }
    );

    // Get test suites count
    const testSuites = await ctx.runQuery(
      internal.testSuites.listAllByBounty,
      { bountyId: typedBountyId }
    );

    const overallReady =
      conversation?.status === "finalized" &&
      generatedTest?.status === "published" &&
      (testSuites?.length ?? 0) > 0;

    return mcpJson({
      repoIndexing: repoConnection
        ? {
            status: repoConnection.status,
            totalFiles: repoConnection.totalFiles,
            languages: repoConnection.languages,
            errorMessage: repoConnection.errorMessage,
          }
        : null,
      conversation: conversation
        ? {
            status: conversation.status,
            autonomous: conversation.autonomous,
            messageCount: conversation.messages.length,
          }
        : null,
      generatedTest: generatedTest
        ? {
            status: generatedTest.status,
            version: generatedTest.version,
            testFramework: generatedTest.testFramework,
            testLanguage: generatedTest.testLanguage,
          }
        : null,
      testSuitesCount: testSuites?.length ?? 0,
      overallReady,
    });
  }),
});

// --- Bounties: Test Suites (public Gherkin only, no step defs) ---
http.route({
  path: "/api/mcp/bounties/test-suites",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId } = body as { bountyId: string };
    if (!bountyId) return mcpError("Missing bountyId");

    const typedBountyId = bountyId as Id<"bounties">;

    // SECURITY: Only expose public suites to agent-facing MCP clients.
    const testSuites = await ctx.runQuery(
      internal.testSuites.listPublicByBounty,
      { bountyId: typedBountyId }
    );

    // Get generated test metadata (framework, language) — no step defs
    const generatedTest = await ctx.runQuery(
      internal.generatedTests.getByBountyIdInternal,
      { bountyId: typedBountyId }
    );

    return mcpJson({
      testSuites: testSuites.map((ts) => ({
        title: ts.title,
        version: ts.version,
        gherkinContent: ts.gherkinContent,
        visibility: ts.visibility,
      })),
      testFramework: generatedTest?.testFramework ?? null,
      testLanguage: generatedTest?.testLanguage ?? null,
    });
  }),
});

// --- Claims: Create ---
http.route({
  path: "/api/mcp/claims/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId, agentId: bodyAgentId } = body as {
      bountyId: string;
      agentId?: string;
    };
    // SECURITY (C1): API key auth overrides agentId from body
    const agentId = auth.authMethod === "api_key" ? auth.userId! : bodyAgentId;
    if (!bountyId || !agentId) return mcpError("Missing bountyId or agentId");

    try {
      const claimId = await ctx.runMutation(internal.bountyClaims.create, {
        bountyId: bountyId as Id<"bounties">,
        agentId: agentId as Id<"users">,
      });

      // Look up repo connection for branch creation info
      let repoInfo: { owner: string; repo: string; baseBranch: string; repositoryUrl: string } | null = null;
      const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
        bountyId: bountyId as Id<"bounties">,
      });
      if (bounty?.repoConnectionId) {
        const repoConn = await ctx.runQuery(internal.repoConnections.getByBountyIdInternal, {
          bountyId: bountyId as Id<"bounties">,
        });
        if (repoConn) {
          repoInfo = {
            owner: repoConn.owner,
            repo: repoConn.repo,
            baseBranch: repoConn.trackedBranch ?? repoConn.defaultBranch,
            repositoryUrl: repoConn.repositoryUrl,
          };
        }
      }

      return mcpJson({ claimId, repoInfo });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create claim";
      return mcpError(message);
    }
  }),
});

// --- Claims: Get active claim by bounty ---
http.route({
  path: "/api/mcp/claims/get",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId } = body as { bountyId?: string };
    if (!bountyId) return mcpError("Missing bountyId");

    const claim = await ctx.runQuery(internal.bountyClaims.getActiveByClaim, {
      bountyId: bountyId as Id<"bounties">,
    });
    if (!claim) return mcpJson({ claim: null });

    const submissions = await ctx.runQuery(internal.submissions.listByAgentId, {
      agentId: claim.agentId,
      bountyId: claim.bountyId,
    });

    return mcpJson({
      claim: {
        claimId: claim._id,
        agentId: claim.agentId,
        status: claim.status,
        expiresAt: claim.expiresAt,
        featureBranchName: claim.featureBranchName,
        featureBranchRepo: claim.featureBranchRepo,
        submissionCount: submissions.length,
        maxSubmissions: 3,
      },
    });
  }),
});

// --- Claims: Release ---
http.route({
  path: "/api/mcp/claims/release",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { claimId, agentId: bodyAgentId } = body as {
      claimId: string;
      agentId?: string;
    };
    // SECURITY (C1): API key auth overrides agentId from body
    const agentId = auth.authMethod === "api_key" ? auth.userId! : bodyAgentId;
    if (!claimId || !agentId) return mcpError("Missing claimId or agentId");

    try {
      await ctx.runMutation(internal.bountyClaims.release, {
        claimId: claimId as Id<"bountyClaims">,
        agentId: agentId as Id<"users">,
      });
      return mcpJson({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to release claim";
      return mcpError(message);
    }
  }),
});

// --- Claims: Extend ---
http.route({
  path: "/api/mcp/claims/extend",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { claimId, agentId: bodyAgentId } = body as {
      claimId: string;
      agentId?: string;
    };
    // SECURITY (C1): API key auth overrides agentId from body
    const agentId = auth.authMethod === "api_key" ? auth.userId! : bodyAgentId;
    if (!claimId || !agentId) return mcpError("Missing claimId or agentId");

    try {
      const result = await ctx.runMutation(
        internal.bountyClaims.extendExpiration,
        {
          claimId: claimId as Id<"bountyClaims">,
          agentId: agentId as Id<"users">,
        }
      );
      return mcpJson(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to extend claim";
      return mcpError(message);
    }
  }),
});

// --- Claims: Update branch info ---
http.route({
  path: "/api/mcp/claims/update-branch",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { claimId, featureBranchName, featureBranchRepo, agentId: bodyAgentId } =
      body as {
        claimId: string;
        featureBranchName: string;
        featureBranchRepo: string;
        agentId?: string;
      };

    if (!claimId || !featureBranchName || !featureBranchRepo) {
      return mcpError("Missing required fields");
    }

    try {
      if (auth.authMethod === "api_key") {
        const claim = await ctx.runQuery(internal.bountyClaims.getByIdInternal, {
          claimId: claimId as Id<"bountyClaims">,
        });
        if (!claim) return mcpError("Claim not found", 404);
        if (claim.agentId !== auth.userId) return mcpError("Forbidden", 403);
      } else if (bodyAgentId) {
        const claim = await ctx.runQuery(internal.bountyClaims.getByIdInternal, {
          claimId: claimId as Id<"bountyClaims">,
        });
        if (!claim) return mcpError("Claim not found", 404);
        if (claim.agentId !== (bodyAgentId as Id<"users">)) return mcpError("Forbidden", 403);
      }

      await ctx.runMutation(internal.bountyClaims.updateBranchInfo, {
        claimId: claimId as Id<"bountyClaims">,
        featureBranchName,
        featureBranchRepo,
      });
      return mcpJson({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update branch info";
      return mcpError(message);
    }
  }),
});

// --- Submissions: Create ---
http.route({
  path: "/api/mcp/submissions/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId, agentId: bodyAgentId, repositoryUrl, commitHash, description } =
      body as {
        bountyId: string;
        agentId?: string;
        repositoryUrl: string;
        commitHash: string;
        description?: string;
      };

    // SECURITY (C1): API key auth overrides agentId from body
    const agentId = auth.authMethod === "api_key" ? auth.userId! : bodyAgentId;

    if (!bountyId || !agentId || !repositoryUrl || !commitHash) {
      return mcpError("Missing required fields");
    }

    try {
      const submissionId = await ctx.runMutation(
        internal.submissions.createFromMcp,
        {
          bountyId: bountyId as Id<"bounties">,
          agentId: agentId as Id<"users">,
          repositoryUrl,
          commitHash,
          description,
        }
      );

      // Create verification
      const verificationId = await ctx.runMutation(
        internal.verifications.create,
        {
          submissionId,
          bountyId: bountyId as Id<"bounties">,
          timeoutSeconds: 600,
        }
      );

      // Trigger verification
      await ctx.scheduler.runAfter(0, internal.verifications.runVerification, {
        verificationId,
        submissionId,
        bountyId: bountyId as Id<"bounties">,
      });

      return mcpJson({ submissionId, verificationId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create submission";
      return mcpError(message);
    }
  }),
});

// --- Submissions: List ---
http.route({
  path: "/api/mcp/submissions/list",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { agentId: bodyAgentId, bountyId, status } = body as {
      agentId?: string;
      bountyId?: string;
      status?: "pending" | "running" | "passed" | "failed";
    };

    // SECURITY (C1): API key auth overrides agentId from body
    const agentId = auth.authMethod === "api_key" ? auth.userId! : bodyAgentId;

    if (!agentId) return mcpError("Missing agentId");

    const submissions = await ctx.runQuery(
      internal.submissions.listByAgentId,
      {
        agentId: agentId as Id<"users">,
        bountyId: bountyId ? (bountyId as Id<"bounties">) : undefined,
        status,
      }
    );

    return mcpJson({ submissions });
  }),
});

// --- Verifications: Get agent-facing status (hidden test details redacted) ---
http.route({
  path: "/api/mcp/verifications/get",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { verificationId, submissionId } = body as {
      verificationId?: string;
      submissionId?: string;
    };

    if (!verificationId && !submissionId) {
      return mcpError("Missing verificationId or submissionId");
    }

    let vId: Id<"verifications"> | undefined;
    let resolvedSubmissionId: Id<"submissions"> | undefined;

    if (verificationId) {
      vId = verificationId as Id<"verifications">;
      const verification = await ctx.runQuery(internal.verifications.getByIdInternal, {
        verificationId: vId,
      });
      if (!verification) return mcpError("Verification not found", 404);
      resolvedSubmissionId = verification.submissionId;
    } else if (submissionId) {
      const verification = await ctx.runQuery(
        internal.verifications.getBySubmissionInternal,
        { submissionId: submissionId as Id<"submissions"> }
      );
      if (!verification) return mcpError("Verification not found", 404);
      vId = verification._id;
      resolvedSubmissionId = verification.submissionId;
    }

    if (!vId) return mcpError("Verification not found", 404);
    if (!resolvedSubmissionId) return mcpError("Verification not found", 404);

    if (auth.authMethod === "api_key") {
      const submission = await ctx.runQuery(internal.submissions.getByIdInternal, {
        submissionId: resolvedSubmissionId,
      });
      if (!submission) return mcpError("Verification not found", 404);

      const userId = auth.userId as string;
      const allowedAsAgent = submission.agentId === userId;
      const allowedAsCreator = await isBountyCreator(
        ctx,
        userId,
        submission.bountyId,
      );
      if (!allowedAsAgent && !allowedAsCreator) return mcpError("Forbidden", 403);
    }

    // Use getAgentStatus to filter hidden test details for agent-facing consumers
    const result = await ctx.runQuery(internal.verifications.getAgentStatus, {
      verificationId: vId,
    });

    if (!result) return mcpError("Verification not found", 404);
    return mcpJson({ verification: result });
  }),
});

// --- Verifications: Latest feedback for a bounty ---
http.route({
  path: "/api/mcp/verifications/feedback",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId } = body as { bountyId: string };
    if (!bountyId) return mcpError("Missing bountyId");

    const typedBountyId = bountyId as Id<"bounties">;
    if (auth.authMethod === "api_key") {
      const userId = auth.userId as string;
      const creatorAccess = await isBountyCreator(ctx, userId, typedBountyId);
      let solverAccess = false;
      if (!creatorAccess) {
        const submissions = await ctx.runQuery(internal.submissions.listByAgentId, {
          agentId: userId as Id<"users">,
          bountyId: typedBountyId,
        });
        solverAccess = submissions.length > 0;
      }
      if (!creatorAccess && !solverAccess) return mcpError("Forbidden", 403);
    }

    // Get the latest verification for this bounty (most recent first)
    const latestVerification = await ctx.runQuery(
      internal.verifications.getLatestByBountyInternal,
      { bountyId: typedBountyId }
    );

    if (!latestVerification) {
      return mcpJson({
        feedbackJson: null,
        verificationStatus: "none",
        attemptNumber: 0,
      });
    }

    // Count total attempts for this bounty
    const allVerifications = await ctx.runQuery(
      internal.verifications.listByBountyInternal,
      { bountyId: typedBountyId }
    );

    return mcpJson({
      feedbackJson: latestVerification.feedbackJson ?? null,
      verificationStatus: latestVerification.status,
      attemptNumber: allVerifications.length,
    });
  }),
});

// ---------------------------------------------------------------------------
// MCP Agent Ratings & Stats Endpoints
// ---------------------------------------------------------------------------

// --- Ratings: Submit ---
http.route({
  path: "/api/mcp/ratings/submit",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const {
      bountyId,
      creatorId,
      codeQuality,
      speed,
      mergedWithoutChanges,
      communication,
      testCoverage,
      comment,
    } = body as {
      bountyId: string;
      creatorId: string;
      codeQuality: number;
      speed: number;
      mergedWithoutChanges: number;
      communication: number;
      testCoverage: number;
      comment?: string;
    };

    if (!bountyId || !creatorId || !codeQuality || !speed || !mergedWithoutChanges || !communication || !testCoverage) {
      return mcpError("Missing required fields");
    }

    try {
      const ratingId = await ctx.runMutation(internal.agentRatings.submitRatingFromMcp, {
        bountyId: bountyId as Id<"bounties">,
        creatorId: creatorId as Id<"users">,
        codeQuality,
        speed,
        mergedWithoutChanges,
        communication,
        testCoverage,
        comment,
      });

      return mcpJson({ ratingId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to submit rating";
      return mcpError(message);
    }
  }),
});

// --- Agents: Get stats by ID ---
http.route({
  path: "/api/mcp/agents/stats",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { agentId } = body as { agentId: string };
    if (!agentId) return mcpError("Missing agentId");

    const stats = await ctx.runQuery(internal.agentStats.getByAgentInternal, {
      agentId: agentId as Id<"users">,
    });

    if (!stats) return mcpJson({ stats: null });

    const user = await ctx.runQuery(internal.users.getByIdInternal, {
      userId: agentId as Id<"users">,
    });

    return mcpJson({
      stats: {
        ...stats,
        agent: user
          ? { name: user.name, avatarUrl: user.avatarUrl, githubUsername: user.githubUsername }
          : null,
      },
    });
  }),
});

// --- Agents: Get own stats ---
http.route({
  path: "/api/mcp/agents/my-stats",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { userId: bodyUserId } = body as { userId?: string };
    // SECURITY (C1): API key auth overrides userId from body
    const userId = auth.authMethod === "api_key" ? auth.userId! : bodyUserId;
    if (!userId) return mcpError("Missing userId");

    const stats = await ctx.runQuery(internal.agentStats.getByAgentInternal, {
      agentId: userId as Id<"users">,
    });

    return mcpJson({ stats: stats ?? null });
  }),
});

// --- Agents: Leaderboard ---
http.route({
  path: "/api/mcp/agents/leaderboard",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { limit } = body as { limit?: number };

    const leaderboard = await ctx.runQuery(internal.agentStats.getLeaderboardInternal, {
      limit: limit ?? 50,
    });

    return mcpJson({ leaderboard });
  }),
});

// ---------------------------------------------------------------------------
// Stripe MCP Endpoints
// ---------------------------------------------------------------------------

// --- Stripe: Setup Intent ---
http.route({
  path: "/api/mcp/stripe/setup-intent",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { userId: bodyUserId, email, name } = body as {
      userId?: string;
      email: string;
      name: string;
    };

    // SECURITY (C1): API key auth overrides userId from body
    const userId = auth.authMethod === "api_key" ? auth.userId! : bodyUserId;

    if (!userId || !email || !name) {
      return mcpError("Missing required fields: userId, email, name");
    }

    try {
      const hosted = await ctx.runAction(internal.stripe.createHostedSetupCheckout, {
        userId: userId as Id<"users">,
        email,
        name,
        successPath: "/settings?setup_complete=true",
        cancelPath: "/settings?setup_canceled=true",
      });

      const setupIntent = await ctx.runAction(internal.stripe.createSetupIntent, {
        userId: userId as Id<"users">,
        email,
        name,
      });

      return mcpJson({
        ...setupIntent,
        checkoutUrl: hosted.checkoutUrl,
        sessionId: hosted.sessionId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create setup intent";
      return mcpError(message);
    }
  }),
});

// --- Stripe: Connect Onboarding ---
http.route({
  path: "/api/mcp/stripe/connect-onboarding",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { userId: bodyUserId, email } = body as {
      userId?: string;
      email: string;
    };

    // SECURITY (C1): API key auth overrides userId from body
    const userId = auth.authMethod === "api_key" ? auth.userId! : bodyUserId;

    if (!userId || !email) {
      return mcpError("Missing required fields: userId, email");
    }

    try {
      const result = await ctx.runAction(
        internal.stripe.createConnectAccount,
        {
          userId: userId as Id<"users">,
          email,
        }
      );

      return mcpJson(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create connect account";
      return mcpError(message);
    }
  }),
});

// --- Stripe: Fund Escrow ---
http.route({
  path: "/api/mcp/stripe/fund-escrow",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId, userId: bodyUserId } = body as {
      bountyId: string;
      userId?: string;
    };

    // SECURITY (C1): API key auth overrides userId from body
    const userId = auth.authMethod === "api_key" ? auth.userId! : bodyUserId;

    if (!bountyId || !userId) {
      return mcpError("Missing required fields: bountyId, userId");
    }

    try {
      const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
        bountyId: bountyId as Id<"bounties">,
      });

      if (!bounty) return mcpError("Bounty not found", 404);

      const result = await ctx.runAction(internal.stripe.createEscrowCharge, {
        bountyId: bountyId as Id<"bounties">,
        userId: userId as Id<"users">,
        amount: bounty.reward,
        currency: bounty.rewardCurrency,
      });

      return mcpJson(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fund escrow";
      return mcpError(message);
    }
  }),
});

// ---------------------------------------------------------------------------
// Workspace Endpoints
// ---------------------------------------------------------------------------

// --- Workspace: Lookup (MCP server routing cache) ---
http.route({
  path: "/api/mcp/workspace/lookup",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { agentId: bodyAgentId, bountyId } = body as { agentId?: string; bountyId: string };
    // SECURITY (C1): API key auth overrides agentId from body
    const agentId = auth.authMethod === "api_key" ? auth.userId! : bodyAgentId;
    if (!agentId || !bountyId) return mcpError("Missing agentId or bountyId");

    const claim = await ctx.runQuery(internal.bountyClaims.getByAgentAndBounty, {
      agentId: agentId as Id<"users">,
      bountyId: bountyId as Id<"bounties">,
    });

    if (!claim) {
      return mcpJson({ found: false, reason: "no_active_claim" });
    }

    let ws = await ctx.runQuery(internal.devWorkspaces.getByClaimId, {
      claimId: claim._id,
    });

    if (!ws) {
      try {
        await ctx.runMutation(internal.bountyClaims.ensureWorkspaceForActiveClaim, {
          claimId: claim._id,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to create workspace for active claim";
        return mcpJson({
          found: false,
          reason: "workspace_provision_failed",
          claimId: claim._id,
          claimStatus: claim.status,
          expiresAt: claim.expiresAt,
          message,
        });
      }

      ws = await ctx.runQuery(internal.devWorkspaces.getByClaimId, {
        claimId: claim._id,
      });
    }

    if (!ws) {
      return mcpJson({
        found: false,
        reason: "workspace_not_yet_created",
        claimId: claim._id,
        claimStatus: claim.status,
        expiresAt: claim.expiresAt,
      });
    }

    return mcpJson({
      found: true,
      claimId: claim._id,
      workspaceId: ws.workspaceId,
      workerHost: ws.workerHost,
      status: ws.status,
      expiresAt: ws.expiresAt,
      errorMessage: ws.errorMessage,
    });
  }),
});

// --- Workspace: Mint short-lived scoped worker token ---
http.route({
  path: "/api/mcp/workspace/token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();
    if (auth.authMethod !== "api_key" || !auth.userId) {
      return mcpError("Scoped workspace tokens require API key authentication", 403);
    }

    const body = await request.json();
    const { workspaceId, routePath } = body as {
      workspaceId?: string;
      routePath?: string;
    };

    if (!workspaceId || !routePath) {
      return mcpError("Missing workspaceId or routePath");
    }
    if (!ALLOWED_WORKSPACE_ROUTE_PATHS.has(routePath)) {
      return mcpError("Route not eligible for scoped worker token", 403);
    }

    const ws = await ctx.runQuery(internal.devWorkspaces.getByWorkspaceId, {
      workspaceId,
    });
    if (!ws) {
      return mcpError("Workspace not found", 404);
    }
    if (ws.agentId !== (auth.userId as Id<"users">)) {
      return mcpError("Forbidden: workspace does not belong to agent", 403);
    }
    if (ws.status === "destroyed") {
      return mcpError("Workspace is destroyed", 409);
    }
    if (ws.expiresAt <= Date.now()) {
      return mcpError("Workspace is expired", 409);
    }

    let signingSecret =
      process.env.WORKER_TOKEN_SIGNING_SECRET || process.env.WORKER_SHARED_SECRET;

    if (ws.attemptWorkerId) {
      const attemptWorker = await ctx.runQuery(internal.attemptWorkers.getByIdInternal, {
        attemptWorkerId: ws.attemptWorkerId,
      });
      if (!attemptWorker) {
        return mcpError("Attempt worker record not found", 503);
      }
      signingSecret = await deriveAttemptTokenSigningSecret(attemptWorker.tokenSigningKeyId);
    }

    if (!signingSecret) {
      return mcpError("Worker token signing secret not configured", 503);
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const exp = nowSeconds + WORKSPACE_AGENT_TOKEN_TTL_SECONDS;
    const randomBytes = crypto.getRandomValues(new Uint8Array(8));
    const jti = Array.from(randomBytes).map((b) => b.toString(16).padStart(2, "0")).join("");

    const payload = {
      iss: WORKSPACE_AGENT_TOKEN_ISSUER,
      aud: WORKSPACE_AGENT_TOKEN_AUDIENCE,
      sub: auth.userId,
      workspaceId,
      bountyId: ws.bountyId,
      routePath,
      iat: nowSeconds,
      nbf: nowSeconds - 2,
      exp,
      jti,
    };

    const token = await signWorkspaceAgentToken(payload, signingSecret);
    return mcpJson({
      token,
      expiresAt: exp * 1000,
    });
  }),
});

// --- Workspace: Attempt startup log (operator diagnostics) ---
http.route({
  path: "/api/mcp/workspace/startup-log",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId, workspaceId, claimId } = body as {
      bountyId?: string;
      workspaceId?: string;
      claimId?: string;
    };

    if (!workspaceId && !claimId && !bountyId) {
      return mcpError("Missing workspaceId, claimId, or bountyId");
    }

    let ws:
      | {
          workspaceId: string;
          attemptWorkerId?: Id<"attemptWorkers">;
          claimId: Id<"bountyClaims">;
          bountyId: Id<"bounties">;
          agentId: Id<"users">;
        }
      | null = null;

    if (workspaceId) {
      ws = await ctx.runQuery(internal.devWorkspaces.getByWorkspaceId, {
        workspaceId,
      });
    } else if (claimId) {
      ws = await ctx.runQuery(internal.devWorkspaces.getByClaimId, {
        claimId: claimId as Id<"bountyClaims">,
      });
    } else if (bountyId) {
      const typedBountyId = bountyId as Id<"bounties">;
      if (auth.authMethod === "api_key" && auth.userId) {
        const userId = auth.userId as Id<"users">;
        const ownClaim = await ctx.runQuery(internal.bountyClaims.getByAgentAndBountyAnyStatus, {
          agentId: userId,
          bountyId: typedBountyId,
        });
        if (ownClaim) {
          ws = await ctx.runQuery(internal.devWorkspaces.getByClaimId, {
            claimId: ownClaim._id,
          });
        } else {
          const creatorAccess = await isBountyCreator(ctx, auth.userId, typedBountyId);
          if (!creatorAccess) return mcpError("Forbidden", 403);
          const activeClaim = await ctx.runQuery(internal.bountyClaims.getActiveByClaim, {
            bountyId: typedBountyId,
          });
          if (activeClaim) {
            ws = await ctx.runQuery(internal.devWorkspaces.getByClaimId, {
              claimId: activeClaim._id,
            });
          }
        }
      } else {
        const activeClaim = await ctx.runQuery(internal.bountyClaims.getActiveByClaim, {
          bountyId: typedBountyId,
        });
        if (activeClaim) {
          ws = await ctx.runQuery(internal.devWorkspaces.getByClaimId, {
            claimId: activeClaim._id,
          });
        }
      }
    }

    if (!ws) {
      return mcpJson({ found: false, message: "Workspace not found" }, 404);
    }
    if (!ws.attemptWorkerId) {
      return mcpJson({
        found: false,
        workspaceId: ws.workspaceId,
        message: "Workspace is not using dedicated attempt VM mode",
      });
    }

    const log = await ctx.runAction(internal.attemptWorkersNode.getStartupLog, {
      attemptWorkerId: ws.attemptWorkerId,
    });

    return mcpJson({
      found: true,
      workspaceId: ws.workspaceId,
      claimId: ws.claimId,
      bountyId: ws.bountyId,
      startupLog: log,
    });
  }),
});

// --- Workspace: Update status (called by worker) ---
http.route({
  path: "/api/mcp/workspace/update-status",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated && !verifyWorkerSecret(request)) {
      return mcpUnauthorized();
    }

    const body = await request.json();
    const { workspaceId, status, vmId, errorMessage } = body as {
      workspaceId: string;
      status: "provisioning" | "ready" | "error" | "destroyed";
      vmId?: string;
      errorMessage?: string;
    };

    if (!workspaceId || !status) return mcpError("Missing workspaceId or status");

    try {
      await ctx.runMutation(internal.devWorkspaces.updateStatus, {
        workspaceId,
        status,
        vmId,
        errorMessage,
        readyAt: status === "ready" ? Date.now() : undefined,
        destroyedAt: status === "destroyed" ? Date.now() : undefined,
      });

      return mcpJson({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update workspace";
      return mcpError(message);
    }
  }),
});

// --- Submissions: Create from workspace (diff-based) ---
http.route({
  path: "/api/mcp/submissions/create-from-workspace",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId, agentId: bodyAgentId, workspaceId, diffPatch, description } = body as {
      bountyId: string;
      agentId?: string;
      workspaceId: string;
      diffPatch: string;
      description?: string;
    };

    // SECURITY (C1): API key auth overrides agentId from body
    const agentId = auth.authMethod === "api_key" ? auth.userId! : bodyAgentId;

    if (!bountyId || !agentId || !workspaceId || !diffPatch) {
      return mcpError("Missing required fields: bountyId, agentId, workspaceId, diffPatch");
    }

    try {
      // Look up workspace for repository info
      const ws = await ctx.runQuery(internal.devWorkspaces.getByWorkspaceId, {
        workspaceId,
      });
      if (!ws) return mcpError("Workspace not found", 404);
      if (ws.agentId !== (agentId as Id<"users">)) {
        return mcpError("Forbidden: workspace does not belong to agent", 403);
      }
      if (ws.bountyId !== (bountyId as Id<"bounties">)) {
        return mcpError("Forbidden: workspace bounty mismatch", 403);
      }

      // Create submission with workspace metadata
      const submissionId = await ctx.runMutation(
        internal.submissions.createFromMcp,
        {
          bountyId: bountyId as Id<"bounties">,
          agentId: agentId as Id<"users">,
          repositoryUrl: ws.repositoryUrl,
          commitHash: workspaceId.replace(/-/g, "").slice(0, 40).padEnd(40, "0"),
          description,
        },
      );

      // Create verification
      const verificationId = await ctx.runMutation(
        internal.verifications.create,
        {
          submissionId,
          bountyId: bountyId as Id<"bounties">,
          timeoutSeconds: 600,
        },
      );

      // Trigger diff-based verification
      await ctx.scheduler.runAfter(0, internal.verifications.runVerificationFromDiff, {
        verificationId,
        submissionId,
        bountyId: bountyId as Id<"bounties">,
        baseRepoUrl: ws.repositoryUrl,
        baseCommitSha: ws.baseCommitSha,
        diffPatch,
        sourceWorkspaceId: workspaceId,
      });

      return mcpJson({ submissionId, verificationId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create submission";
      return mcpError(message);
    }
  }),
});

// ---------------------------------------------------------------------------
// MCP Notification Endpoints
// ---------------------------------------------------------------------------

http.route({
  path: "/api/mcp/notifications/list",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { userId: bodyUserId, limit } = body as { userId?: string; limit?: number };
    // SECURITY (C1): API key auth overrides userId from body
    const userId = auth.authMethod === "api_key" ? auth.userId! : bodyUserId;
    if (!userId) return mcpError("Missing userId");

    const notifications = await ctx.runQuery(
      internal.notifications.listUnread,
      { userId: userId as Id<"users">, limit: limit ?? 20 }
    );

    return mcpJson({ notifications });
  }),
});

http.route({
  path: "/api/mcp/notifications/mark-read",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { notificationIds, userId: bodyUserId } = body as { notificationIds: string[]; userId?: string };
    if (!notificationIds || !Array.isArray(notificationIds)) {
      return mcpError("Missing notificationIds array");
    }

    const userId = auth.authMethod === "api_key" ? auth.userId! : bodyUserId;
    if (!userId) return mcpError("Missing userId");

    await ctx.runMutation(internal.notifications.markReadForUser, {
      userId: userId as Id<"users">,
      notificationIds: notificationIds as Id<"notifications">[],
    });

    return mcpJson({ success: true });
  }),
});

// ---------------------------------------------------------------------------
// Public Bounty Endpoint (no auth required)
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

http.route({
  path: "/public/bounty",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const bountyId = url.searchParams.get("id");
    if (!bountyId) {
      return new Response("Missing id parameter", { status: 400 });
    }

    let bounty;
    try {
      bounty = await ctx.runQuery(internal.bounties.getPublicView, {
        bountyId: bountyId as Id<"bounties">,
      });
    } catch {
      return new Response("Invalid bounty ID", { status: 400 });
    }

    if (!bounty) {
      return new Response("Bounty not found", { status: 404 });
    }

    const accept = request.headers.get("accept") ?? "";
    if (accept.includes("application/json")) {
      return new Response(JSON.stringify(bounty), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const appUrl = process.env.APP_URL || "http://localhost:3000";
    const title = escapeHtml(bounty.title);
    const description = escapeHtml(
      bounty.description.length > 200
        ? bounty.description.slice(0, 200) + "..."
        : bounty.description
    );
    const reward = escapeHtml(`${bounty.reward} ${bounty.rewardCurrency}`);
    const tags = bounty.tags?.map((t: string) => escapeHtml(t)).join(", ") ?? "";
    const deadline = bounty.deadline
      ? new Date(bounty.deadline).toLocaleDateString()
      : "No deadline";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - arcagent Bounty</title>
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="Reward: ${reward} — ${description}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="Reward: ${reward} — ${description}">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8f9fa;color:#1a1a2e;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:640px;width:100%;padding:32px}
    .badge{display:inline-block;padding:4px 12px;border-radius:999px;font-size:13px;font-weight:500;margin-right:8px}
    .badge-status{background:#e8f5e9;color:#2e7d32}
    .badge-tag{background:#e3f2fd;color:#1565c0}
    h1{font-size:24px;margin:16px 0 8px}
    .reward{font-size:20px;font-weight:600;color:#6c5ce7;margin:12px 0}
    .desc{color:#555;line-height:1.6;margin:16px 0}
    .meta{display:flex;gap:24px;flex-wrap:wrap;color:#888;font-size:14px;margin:16px 0}
    .cta{display:inline-block;margin-top:20px;padding:12px 24px;background:#6c5ce7;color:#fff;text-decoration:none;border-radius:8px;font-weight:500;font-size:15px}
    .cta:hover{background:#5a4bd1}
    .footer{margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-size:13px;color:#999}
    .footer code{background:#f1f1f1;padding:2px 6px;border-radius:4px;font-size:12px}
  </style>
</head>
<body>
  <div class="card">
    <span class="badge badge-status">${escapeHtml(bounty.status)}</span>
    <h1>${title}</h1>
    <div class="reward">${reward}</div>
    <p class="desc">${escapeHtml(bounty.description)}</p>
    ${tags ? `<div style="margin:12px 0">${bounty.tags!.map((t: string) => `<span class="badge badge-tag">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
    <div class="meta">
      <span>By ${escapeHtml(bounty.creatorName)}</span>
      <span>Deadline: ${escapeHtml(deadline)}</span>
      <span>${bounty.publicTestCount} public / ${bounty.hiddenTestCount} hidden tests</span>
      ${bounty.claimDurationHours ? `<span>Claim: ${bounty.claimDurationHours}h</span>` : ""}
    </div>
    <a class="cta" href="${escapeHtml(appUrl)}/bounties/${escapeHtml(bountyId)}">View Full Bounty</a>
    <div class="footer">
      AI agents: use bounty ID <code>${escapeHtml(bountyId)}</code> with arcagent MCP tools
    </div>
  </div>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }),
});

// ---------------------------------------------------------------------------
// Workspace Crash Report Endpoint (called by worker)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/workspace/crash-report",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyWorkerSecret(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body: {
      workspaceId: string;
      bountyId: string;
      agentId: string;
      claimId: string;
      vmId: string;
      workerInstanceId: string;
      crashType: string;
      errorMessage: string;
      lastKnownStatus: string;
      vmUptimeMs?: number;
      lastHeartbeatAt?: number;
      lastActivityAt?: number;
      resourceUsage?: {
        cpuPercent?: number;
        memoryMb?: number;
        diskMb?: number;
      };
      recovered: boolean;
      recoveryAction?: string;
      hostMetrics?: {
        totalActiveVMs?: number;
        hostMemoryUsedPercent?: number;
        hostCpuUsedPercent?: number;
      };
    };

    try {
      body = await request.json();
    } catch {
      return mcpError("Invalid JSON body", 400);
    }

    if (!body.workspaceId || !body.bountyId || !body.crashType) {
      return mcpError("Missing required fields: workspaceId, bountyId, crashType");
    }

    try {
      await ctx.runMutation(internal.workspaceCrashReports.recordCrashReport, {
        workspaceId: body.workspaceId,
        bountyId: body.bountyId as Id<"bounties">,
        agentId: body.agentId as Id<"users">,
        claimId: body.claimId as Id<"bountyClaims">,
        vmId: body.vmId ?? "",
        workerInstanceId: body.workerInstanceId ?? "",
        crashType: body.crashType as
          | "vm_process_exited" | "vm_unresponsive" | "worker_restart"
          | "oom_killed" | "disk_full" | "provision_failed"
          | "vsock_error" | "network_error" | "timeout" | "unknown",
        errorMessage: body.errorMessage ?? "",
        lastKnownStatus: body.lastKnownStatus ?? "unknown",
        vmUptimeMs: body.vmUptimeMs,
        lastHeartbeatAt: body.lastHeartbeatAt,
        lastActivityAt: body.lastActivityAt,
        resourceUsage: body.resourceUsage,
        recovered: body.recovered ?? false,
        recoveryAction: body.recoveryAction as
          | "reconnected" | "reprovisioned" | "abandoned" | undefined,
        hostMetrics: body.hostMetrics,
      });

      return mcpJson({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to record crash report";
      return mcpError(message, 500);
    }
  }),
});

// --- Workspace: Crash reports query (for MCP) ---
http.route({
  path: "/api/mcp/workspace/crash-reports",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await verifyMcpAuth(ctx, request);
    if (!auth.authenticated) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId } = body as { bountyId: string };
    if (!bountyId) return mcpError("Missing bountyId");

    const typedBountyId = bountyId as Id<"bounties">;
    let reports;
    if (auth.authMethod === "api_key") {
      const userId = auth.userId as string;
      const creatorAccess = await isBountyCreator(ctx, userId, typedBountyId);
      if (creatorAccess) {
        reports = await ctx.runQuery(
          internal.workspaceCrashReports.getCrashReports,
          { bountyId: typedBountyId }
        );
      } else {
        const claim = await ctx.runQuery(internal.bountyClaims.getByAgentAndBountyAnyStatus, {
          agentId: userId as Id<"users">,
          bountyId: typedBountyId,
        });
        if (!claim) return mcpError("Forbidden", 403);
        reports = await ctx.runQuery(
          internal.workspaceCrashReports.getCrashReportsForBountyAndAgent,
          { bountyId: typedBountyId, agentId: userId as Id<"users"> }
        );
      }
    } else {
      reports = await ctx.runQuery(
        internal.workspaceCrashReports.getCrashReports,
        { bountyId: typedBountyId }
      );
    }

    return mcpJson({ reports });
  }),
});

// ---------------------------------------------------------------------------
// Worker Verification Result Endpoint
// ---------------------------------------------------------------------------

const GATE_TYPE_MAP: Record<string, string> = {
  build: "build",
  lint: "lint",
  typecheck: "typecheck",
  security: "security",
  sonarqube: "sonarqube",
  snyk: "snyk",
  memory: "memory",
};

const GATE_STATUS_MAP: Record<string, string> = {
  passed: "passed",
  pass: "passed",
  failed: "failed",
  fail: "failed",
  warning: "warning",
  warn: "warning",
};

http.route({
  path: "/api/verification/result",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyWorkerSecret(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body: {
      submissionId: string;
      bountyId: string;
      jobId: string;
      overallStatus: "pass" | "fail" | "error";
      jobHmac?: string;
      callbackTimestampMs?: number;
      callbackNonce?: string;
      callbackSignature?: string;
      gates: Array<{
        gate: string;
        status: string;
        durationMs: number;
        summary: string;
        details?: Record<string, unknown>;
      }>;
      totalDurationMs: number;
      feedbackJson?: string;
      steps?: Array<{
        scenarioName: string;
        featureName: string;
        status: "pass" | "fail" | "skip" | "error";
        executionTimeMs: number;
        output?: string;
        stepNumber: number;
        visibility: "public" | "hidden";
      }>;
    };

    try {
      body = await request.json();
    } catch {
      return mcpError("Invalid JSON body", 400);
    }

    if (!body.submissionId || !body.bountyId || !body.overallStatus) {
      return mcpError("Missing required fields: submissionId, bountyId, overallStatus");
    }

    const submissionId = body.submissionId as Id<"submissions">;
    const bountyId = body.bountyId as Id<"bounties">;

    try {
      // Look up the verification for this submission
      const verification = await ctx.runQuery(
        internal.verifications.getBySubmissionInternal,
        { submissionId }
      );
      if (!verification) {
        return mcpError("Verification not found for submission", 404);
      }
      const verificationId = verification._id;

      // SECURITY (H6): Verify per-job HMAC token — mandatory.
      // This prevents forged results even if WORKER_SHARED_SECRET is compromised.
      if (!body.jobHmac) {
        return mcpError("Missing required job HMAC token", 403);
      }
      const hmacValid = await verifyJobHmac(
        body.jobHmac,
        verificationId,
        body.submissionId,
        body.bountyId,
      );
      if (!hmacValid) {
        return mcpError("Invalid job HMAC token", 403);
      }

      // SECURITY (H7): Verify signed callback envelope (timestamp + nonce).
      if (
        body.callbackTimestampMs === undefined ||
        !body.callbackNonce ||
        !body.callbackSignature
      ) {
        return mcpError(
          "Missing callback auth envelope fields: callbackTimestampMs, callbackNonce, callbackSignature",
          403,
        );
      }
      if (!isFreshWorkerCallbackTimestamp(body.callbackTimestampMs)) {
        return mcpError("Stale or invalid callback timestamp", 403);
      }
      const callbackSignatureValid = await verifyWorkerCallbackSignature(
        body.callbackSignature,
        {
          submissionId: body.submissionId,
          bountyId: body.bountyId,
          jobId: body.jobId,
          overallStatus: body.overallStatus,
          jobHmac: body.jobHmac,
          callbackTimestampMs: body.callbackTimestampMs,
          callbackNonce: body.callbackNonce,
        },
      );
      if (!callbackSignatureValid) {
        return mcpError("Invalid callback signature", 403);
      }
      const callbackNonceApi = internal as unknown as {
        workerCallbackNonces: { consume: unknown };
      };
      const nonceResult = await ctx.runMutation(
        callbackNonceApi.workerCallbackNonces.consume as never,
        {
          nonce: body.callbackNonce,
          verificationId,
          ttlMs: 10 * 60 * 1000,
        },
      );
      if (!nonceResult.accepted) {
        return mcpError("Callback nonce already used", 409);
      }

      // SECURITY (M12): Reject late results for verifications that have
      // already been timed out by the cron. This closes the race window
      // between worker result arrival and cron timeout marking.
      if (verification.status === "failed" || verification.status === "passed") {
        return mcpJson({
          success: false,
          reason: `Verification already in terminal state: ${verification.status}`,
          verificationId,
        });
      }

      // 1. Record each gate result (skip "test" gate — those are steps)
      for (const gate of body.gates) {
        const gateType = GATE_TYPE_MAP[gate.gate];
        const gateStatus = GATE_STATUS_MAP[gate.status];
        if (gateType && gateStatus) {
          const issues: string[] = [];
          if (gate.summary) issues.push(gate.summary);
          const detailsJson = gate.details ? JSON.stringify(gate.details) : undefined;
          await ctx.runMutation(internal.sanityGates.record, {
            verificationId,
            gateType: gateType as "build" | "lint" | "typecheck" | "security" | "sonarqube" | "snyk" | "memory",
            tool: gate.summary || gate.gate,
            status: gateStatus as "passed" | "failed" | "warning",
            issues: issues.length > 0 ? issues : undefined,
            detailsJson,
          });
        }
      }

      // 2. Record step results (batch insert)
      if (body.steps && body.steps.length > 0) {
        await ctx.runMutation(internal.verificationSteps.createInternal, {
          steps: body.steps.map((step) => ({
            verificationId,
            scenarioName: step.scenarioName,
            featureName: step.featureName,
            status: step.status,
            executionTimeMs: step.executionTimeMs,
            output: step.output,
            stepNumber: step.stepNumber,
            visibility: step.visibility,
          })),
        });
      }

      // 3. Update verification status
      const verificationStatus = body.overallStatus === "pass" ? "passed" : "failed";
      await ctx.runMutation(internal.verifications.updateResult, {
        verificationId,
        status: verificationStatus as "passed" | "failed",
        completedAt: Date.now(),
        feedbackJson: body.feedbackJson,
      });

      // 4. Update submission status
      await ctx.runMutation(internal.submissions.updateStatus, {
        submissionId,
        status: verificationStatus as "passed" | "failed",
      });

      // 5. Update verificationJob status (if exists)
      const job = await ctx.runQuery(
        internal.verificationJobs.getByVerificationIdInternal,
        { verificationId }
      );
      if (job) {
        await ctx.runMutation(internal.verificationJobs.updateStatus, {
          jobId: job._id,
          status: body.overallStatus === "pass" ? "completed" : "failed",
          completedAt: Date.now(),
        });
      }

      // 6. If passed, trigger payout
      if (body.overallStatus === "pass") {
        await ctx.scheduler.runAfter(
          0,
          internal.verifications.triggerPayoutOnVerificationPass,
          {
            verificationId,
            bountyId,
            submissionId,
          }
        );
      }

      return mcpJson({ success: true, verificationId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to process verification result";
      console.error(`[verification/result] Error: ${message}`);
      return mcpError(message, 500);
    }
  }),
});

// ---------------------------------------------------------------------------
// Stripe Webhook
// ---------------------------------------------------------------------------

http.route({
  path: "/stripe-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      return new Response("Missing stripe-signature header", { status: 400 });
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("STRIPE_WEBHOOK_SECRET not configured");
      return new Response("Webhook secret not configured", { status: 500 });
    }

    const payload = await request.text();

    let event: {
      type: string;
      data: {
        object: Record<string, unknown>;
      };
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Stripe = require("stripe");
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      event = await stripe.webhooks.constructEventAsync(
        payload,
        signature,
        webhookSecret
      ) as typeof event;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("Stripe webhook verification failed:", message);
      return new Response(`Webhook Error: ${message}`, { status: 400 });
    }

    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object as { id: string; metadata?: { bountyId?: string } };
        if (pi.metadata?.bountyId) {
          await ctx.runMutation(internal.stripe.updateBountyEscrow, {
            bountyId: pi.metadata.bountyId as Id<"bounties">,
            stripePaymentIntentId: pi.id,
            escrowStatus: "funded",
          });
        }
        break;
      }
      case "payment_intent.payment_failed": {
        const pi = event.data.object as { id: string; metadata?: { bountyId?: string; convexUserId?: string } };
        if (pi.metadata?.bountyId) {
          console.warn(
            `Payment failed for bounty ${pi.metadata.bountyId}: ${pi.id}`
          );
          // Look up bounty to get creator and title for the notification
          const failedBounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
            bountyId: pi.metadata.bountyId as Id<"bounties">,
          });
          if (failedBounty) {
            await ctx.runMutation(internal.notifications.createPaymentFailed, {
              userId: failedBounty.creatorId,
              bountyId: failedBounty._id,
              title: failedBounty.title,
              paymentIntentId: pi.id,
            });
          }
        }
        break;
      }
      case "setup_intent.succeeded": {
        const si = event.data.object as { metadata?: { convexUserId?: string } };
        if (si.metadata?.convexUserId) {
          await ctx.runMutation(internal.users.markHasPaymentMethod, {
            userId: si.metadata.convexUserId as Id<"users">,
          });
        }
        break;
      }
      case "account.updated": {
        const account = event.data.object as {
          id: string;
          charges_enabled: boolean;
          payouts_enabled: boolean;
        };
        const onboardingComplete =
          account.charges_enabled && account.payouts_enabled;
        await ctx.runMutation(
          internal.stripe.updateConnectOnboardingStatus,
          {
            stripeConnectAccountId: account.id,
            onboardingComplete,
          }
        );
        break;
      }
      default:
        console.log(`Unhandled Stripe event: ${event.type}`);
    }

    return new Response("OK", { status: 200 });
  }),
});

export default http;
