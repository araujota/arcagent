import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

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
    const { Webhook } = await import("svix");
    const wh = new Webhook(webhookSecret);

    let event: {
      type: string;
      data: {
        id: string;
        first_name?: string;
        last_name?: string;
        email_addresses?: Array<{ email_address: string }>;
        image_url?: string;
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

        await ctx.runMutation(internal.users.upsertFromClerk, {
          clerkId: data.id,
          name,
          email,
          avatarUrl: data.image_url,
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

/**
 * SECURITY (H3): Constant-time secret comparison that does NOT leak
 * the secret length via an early-return on length mismatch.
 * Both strings are padded to the same length before comparison.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length, 1);
  let result = a.length ^ b.length; // length mismatch contributes to failure
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i % a.length) || 0) ^ (b.charCodeAt(i % b.length) || 0);
  }
  return result === 0;
}

function verifyMcpSecret(request: Request): boolean {
  const secret = process.env.MCP_SHARED_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;

  const token = header.slice("Bearer ".length);
  return constantTimeEqual(token, secret);
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

// --- Auth: Validate API key ---
http.route({
  path: "/api/mcp/auth/validate",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
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

// --- Agents: Create agent user + API key ---
http.route({
  path: "/api/mcp/agents/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { name, email, clerkId, keyHash, keyPrefix, githubUsername } =
      body as {
        name: string;
        email: string;
        clerkId: string;
        keyHash: string;
        keyPrefix: string;
        githubUsername?: string;
      };

    if (!name || !email || !clerkId || !keyHash || !keyPrefix) {
      return mcpError("Missing required fields");
    }

    try {
      const userId = await ctx.runMutation(internal.users.createApiAgent, {
        name,
        email,
        clerkId,
        githubUsername,
      });

      await ctx.runMutation(internal.apiKeys.create, {
        userId,
        keyHash,
        keyPrefix,
        name: `${name}'s API key`,
        scopes: ["bounties:read", "bounties:claim", "bounties:create", "submissions:write"],
      });

      return mcpJson({ userId });
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
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

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
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

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
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const {
      creatorId,
      title,
      description,
      reward,
      rewardCurrency,
      paymentMethod,
      deadline,
      tags,
      repositoryUrl,
    } = body as {
      creatorId: string;
      title: string;
      description: string;
      reward: number;
      rewardCurrency: string;
      paymentMethod: "stripe" | "web3";
      deadline?: number;
      tags?: string[];
      repositoryUrl?: string;
    };

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
        status: "active",
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

      return mcpJson({ bountyId, repoConnectionId, conversationId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create bounty";
      return mcpError(message);
    }
  }),
});

// --- Bounties: Cancel ---
http.route({
  path: "/api/mcp/bounties/cancel",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId, creatorId } = body as {
      bountyId: string;
      creatorId: string;
    };

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
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

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

// --- Claims: Create ---
http.route({
  path: "/api/mcp/claims/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId, agentId } = body as {
      bountyId: string;
      agentId: string;
    };
    if (!bountyId || !agentId) return mcpError("Missing bountyId or agentId");

    try {
      const claimId = await ctx.runMutation(internal.bountyClaims.create, {
        bountyId: bountyId as Id<"bounties">,
        agentId: agentId as Id<"users">,
      });

      return mcpJson({ claimId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create claim";
      return mcpError(message);
    }
  }),
});

// --- Claims: Release ---
http.route({
  path: "/api/mcp/claims/release",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { claimId, agentId } = body as {
      claimId: string;
      agentId: string;
    };
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
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { claimId, agentId } = body as {
      claimId: string;
      agentId: string;
    };
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

// --- Claims: Update fork info ---
http.route({
  path: "/api/mcp/claims/update-fork",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { claimId, forkRepositoryUrl, forkAccessToken, forkTokenExpiresAt } =
      body as {
        claimId: string;
        forkRepositoryUrl: string;
        forkAccessToken: string;
        forkTokenExpiresAt: number;
      };

    if (!claimId || !forkRepositoryUrl || !forkAccessToken || !forkTokenExpiresAt) {
      return mcpError("Missing required fields");
    }

    try {
      await ctx.runMutation(internal.bountyClaims.updateForkInfo, {
        claimId: claimId as Id<"bountyClaims">,
        forkRepositoryUrl,
        forkAccessToken,
        forkTokenExpiresAt,
      });
      return mcpJson({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update fork info";
      return mcpError(message);
    }
  }),
});

// --- Submissions: Create ---
http.route({
  path: "/api/mcp/submissions/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId, agentId, repositoryUrl, commitHash, description } =
      body as {
        bountyId: string;
        agentId: string;
        repositoryUrl: string;
        commitHash: string;
        description?: string;
      };

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
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { agentId, bountyId, status } = body as {
      agentId: string;
      bountyId?: string;
      status?: "pending" | "running" | "passed" | "failed";
    };

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
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { verificationId, submissionId } = body as {
      verificationId?: string;
      submissionId?: string;
    };

    if (!verificationId && !submissionId) {
      return mcpError("Missing verificationId or submissionId");
    }

    let vId: Id<"verifications"> | undefined;

    if (verificationId) {
      vId = verificationId as Id<"verifications">;
    } else if (submissionId) {
      const verification = await ctx.runQuery(
        internal.verifications.getBySubmissionInternal,
        { submissionId: submissionId as Id<"submissions"> }
      );
      if (!verification) return mcpError("Verification not found", 404);
      vId = verification._id;
    }

    if (!vId) return mcpError("Verification not found", 404);

    // Use getAgentStatus to filter hidden test details for agent-facing consumers
    const result = await ctx.runQuery(internal.verifications.getAgentStatus, {
      verificationId: vId,
    });

    if (!result) return mcpError("Verification not found", 404);
    return mcpJson({ verification: result });
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
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { userId, email, name } = body as {
      userId: string;
      email: string;
      name: string;
    };

    if (!userId || !email || !name) {
      return mcpError("Missing required fields: userId, email, name");
    }

    try {
      const result = await ctx.runAction(internal.stripe.createSetupIntent, {
        userId: userId as Id<"users">,
        email,
        name,
      });

      return mcpJson(result);
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
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { userId, email } = body as {
      userId: string;
      email: string;
    };

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
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { bountyId, userId } = body as {
      bountyId: string;
      userId: string;
    };

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
// MCP Notification Endpoints
// ---------------------------------------------------------------------------

http.route({
  path: "/api/mcp/notifications/list",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { userId, limit } = body as { userId: string; limit?: number };
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
    if (!verifyMcpSecret(request)) return mcpUnauthorized();

    const body = await request.json();
    const { notificationIds } = body as { notificationIds: string[] };
    if (!notificationIds || !Array.isArray(notificationIds)) {
      return mcpError("Missing notificationIds array");
    }

    await ctx.runMutation(internal.notifications.markRead, {
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

/**
 * SECURITY (H6): Verify per-job HMAC token to prevent forged verification results.
 */
async function verifyJobHmac(
  hmac: string,
  verificationId: string,
  submissionId: string,
  bountyId: string,
): Promise<boolean> {
  const secret = process.env.WORKER_SHARED_SECRET || "";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = `${verificationId}:${submissionId}:${bountyId}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const expected = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return constantTimeEqual(hmac, expected);
}

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
      gates: Array<{
        gate: string;
        status: string;
        durationMs: number;
        summary: string;
        details?: Record<string, unknown>;
      }>;
      totalDurationMs: number;
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

      // SECURITY (H6): Verify per-job HMAC token if present.
      // This prevents forged results even if WORKER_SHARED_SECRET is compromised.
      if (body.jobHmac) {
        const hmacValid = await verifyJobHmac(
          body.jobHmac,
          verificationId,
          body.submissionId,
          body.bountyId,
        );
        if (!hmacValid) {
          return mcpError("Invalid job HMAC token", 403);
        }
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
          await ctx.runMutation(internal.sanityGates.record, {
            verificationId,
            gateType: gateType as "build" | "lint" | "typecheck" | "security" | "sonarqube" | "snyk" | "memory",
            tool: gate.summary || gate.gate,
            status: gateStatus as "passed" | "failed" | "warning",
            issues: issues.length > 0 ? issues : undefined,
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
      event = stripe.webhooks.constructEvent(
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
        const pi = event.data.object as { id: string; metadata?: { bountyId?: string } };
        if (pi.metadata?.bountyId) {
          console.warn(
            `Payment failed for bounty ${pi.metadata.bountyId}: ${pi.id}`
          );
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
