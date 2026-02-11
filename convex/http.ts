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
// MCP Internal Endpoints (shared-secret auth)
// ---------------------------------------------------------------------------

function verifyMcpSecret(request: Request): boolean {
  const secret = process.env.MCP_SHARED_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;

  const token = header.slice("Bearer ".length);
  if (token.length !== secret.length) return false;

  // Constant-time comparison
  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return result === 0;
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
        scopes: ["bounties:read", "bounties:claim", "submissions:write"],
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

// --- Verifications: Get full status ---
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

    const result = await ctx.runQuery(internal.verifications.getFullStatus, {
      verificationId: vId,
    });

    if (!result) return mcpError("Verification not found", 404);
    return mcpJson({ verification: result });
  }),
});

export default http;
