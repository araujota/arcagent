import { query, internalMutation, internalAction, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { getCurrentUser, requireAuth } from "./lib/utils";
import { calculatePlatformFee, PLATFORM_FEE_RATE } from "./lib/fees";
import { requiresGitHubInstallationToken, resolveGitHubTokenForRepo } from "./lib/githubApp";
import { fetchWithRetry } from "./lib/httpRetry";

type HiddenFailureMechanismKey =
  | "assertion_mismatch"
  | "runtime_exception"
  | "module_or_path_error"
  | "timeout_or_hang"
  | "permission_or_filesystem"
  | "api_contract_or_validation"
  | "unknown_edge_case";

type HiddenFailureMechanism = {
  key: HiddenFailureMechanismKey;
  label: string;
  count: number;
  guidance: string;
};

type VerificationLogSource =
  | "verification_result_callback"
  | "verification_lifecycle"
  | "verification_timeout"
  | "system";

type VerificationLogLevel = "info" | "warning" | "error";

type VerificationLogSearchArgs = {
  verificationId?: string;
  submissionId?: string;
  bountyId?: string;
  agentId?: string;
  source?: VerificationLogSource;
  level?: VerificationLogLevel;
  eventType?: string;
  gate?: string;
  visibility?: "public" | "hidden";
  limit?: number;
};

const VERIFICATION_LOG_MAX_LIMIT = 1000;
const VERIFICATION_LOG_DEFAULT_LIMIT = 200;
const VERIFICATION_LOG_SCAN_MULTIPLIER = 5;
const VERIFICATION_LOG_MAX_MESSAGE_LEN = 20_000;
const VERIFICATION_LOG_MAX_DETAILS_LEN = 120_000;

const VERIFICATION_LOG_SOURCE_VALIDATOR = v.union(
  v.literal("verification_result_callback"),
  v.literal("verification_lifecycle"),
  v.literal("verification_timeout"),
  v.literal("system"),
);

const VERIFICATION_LOG_LEVEL_VALIDATOR = v.union(
  v.literal("info"),
  v.literal("warning"),
  v.literal("error"),
);

function truncateForLog(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}\n... (truncated, ${value.length} chars total)`;
}

function safeStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function normalizeLogLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return VERIFICATION_LOG_DEFAULT_LIMIT;
  const normalized = Math.floor(limit);
  if (normalized < 1) return 1;
  if (normalized > VERIFICATION_LOG_MAX_LIMIT) return VERIFICATION_LOG_MAX_LIMIT;
  return normalized;
}

async function queryVerificationLogs(
  ctx: {
    db: {
      query: (table: "verificationLogs") => {
        withIndex: (index: string, cb: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) => {
          order: (dir: "asc" | "desc") => { take: (count: number) => Promise<Array<Record<string, unknown>>> };
        };
        order: (dir: "asc" | "desc") => { take: (count: number) => Promise<Array<Record<string, unknown>>> };
      };
    };
  },
  args: VerificationLogSearchArgs,
): Promise<Array<Record<string, unknown>>> {
  const limit = normalizeLogLimit(args.limit);
  const scanLimit = Math.min(limit * VERIFICATION_LOG_SCAN_MULTIPLIER, VERIFICATION_LOG_MAX_LIMIT);

  let rows: Array<Record<string, unknown>>;
  if (args.verificationId) {
    rows = await ctx.db
      .query("verificationLogs")
      .withIndex("by_verificationId_and_createdAt", (q) => q.eq("verificationId", args.verificationId))
      .order("desc")
      .take(scanLimit);
  } else if (args.submissionId) {
    rows = await ctx.db
      .query("verificationLogs")
      .withIndex("by_submissionId_and_createdAt", (q) => q.eq("submissionId", args.submissionId))
      .order("desc")
      .take(scanLimit);
  } else if (args.bountyId) {
    rows = await ctx.db
      .query("verificationLogs")
      .withIndex("by_bountyId_and_createdAt", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .take(scanLimit);
  } else if (args.agentId) {
    rows = await ctx.db
      .query("verificationLogs")
      .withIndex("by_agentId_and_createdAt", (q) => q.eq("agentId", args.agentId))
      .order("desc")
      .take(scanLimit);
  } else if (args.eventType) {
    rows = await ctx.db
      .query("verificationLogs")
      .withIndex("by_eventType_and_createdAt", (q) => q.eq("eventType", args.eventType))
      .order("desc")
      .take(scanLimit);
  } else if (args.source) {
    rows = await ctx.db
      .query("verificationLogs")
      .withIndex("by_source_and_createdAt", (q) => q.eq("source", args.source))
      .order("desc")
      .take(scanLimit);
  } else if (args.level) {
    rows = await ctx.db
      .query("verificationLogs")
      .withIndex("by_level_and_createdAt", (q) => q.eq("level", args.level))
      .order("desc")
      .take(scanLimit);
  } else {
    rows = await ctx.db
      .query("verificationLogs")
      .order("desc")
      .take(scanLimit);
  }

  return rows
    .filter((row) => {
      if (args.verificationId && row.verificationId !== args.verificationId) return false;
      if (args.submissionId && row.submissionId !== args.submissionId) return false;
      if (args.bountyId && row.bountyId !== args.bountyId) return false;
      if (args.agentId && row.agentId !== args.agentId) return false;
      if (args.source && row.source !== args.source) return false;
      if (args.level && row.level !== args.level) return false;
      if (args.eventType && row.eventType !== args.eventType) return false;
      if (args.gate && row.gate !== args.gate) return false;
      if (args.visibility && row.visibility !== args.visibility) return false;
      return true;
    })
    .slice(0, limit);
}

/**
 * SECURITY (H8/M8): Require that the caller is the bounty creator,
 * the submitting agent, or an admin to view verification details.
 */
async function requireBountyAccess(
  ctx: { db: { get: (id: unknown) => Promise<unknown> } },
  userId: string,
  userRole: string,
  bountyId: unknown,
  submissionId?: unknown,
): Promise<void> {
  if (userRole === "admin") return;

  // Check if user is the bounty creator
  const bounty = await ctx.db.get(bountyId) as { creatorId: string } | null;
  if (bounty && bounty.creatorId === userId) return;

  // Check if user is the submitting agent
  if (submissionId) {
    const submission = await ctx.db.get(submissionId) as { agentId: string } | null;
    if (submission && submission.agentId === userId) return;
  }

  throw new Error("Access denied: you must be the bounty creator, the submitting agent, or an admin");
}

export const getBySubmission = query({
  args: { submissionId: v.id("submissions") },
  handler: async (ctx, args) => {
    // SECURITY (H8): Require authentication and access check
    const user = requireAuth(await getCurrentUser(ctx));

    const verification = await ctx.db
      .query("verifications")
      .withIndex("by_submissionId", (q) =>
        q.eq("submissionId", args.submissionId)
      )
      .first();

    if (!verification) return null;

    await requireBountyAccess(
      ctx, user._id, user.role, verification.bountyId, args.submissionId
    );

    return verification;
  },
});

export const listByBounty = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    // SECURITY (H8): Require authentication and access check
    const user = requireAuth(await getCurrentUser(ctx));
    await requireBountyAccess(ctx, user._id, user.role, args.bountyId);

    const verifications = await ctx.db
      .query("verifications")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();

    return await Promise.all(
      verifications.map(async (v) => {
        const submission = await ctx.db.get(v.submissionId);
        return { ...v, submission };
      })
    );
  },
});

export const create = internalMutation({
  args: {
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
    timeoutSeconds: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("verifications", {
      submissionId: args.submissionId,
      bountyId: args.bountyId,
      status: "pending",
      timeoutSeconds: args.timeoutSeconds,
    });
  },
});

export const updateResult = internalMutation({
  args: {
    verificationId: v.id("verifications"),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("passed"),
      v.literal("failed")
    ),
    result: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    errorLog: v.optional(v.string()),
    feedbackJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { verificationId, ...updates } = args;
    const filteredUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined)
    );
    await ctx.db.patch(verificationId, filteredUpdates);

    if (args.status === "passed") {
      const verification = await ctx.db.get(verificationId);
      if (verification) {
        const bounty = await ctx.db.get(verification.bountyId);
        const submission = await ctx.db.get(verification.submissionId);
        const agent = submission ? await ctx.db.get(submission.agentId) : null;
        if (bounty) {
          await ctx.scheduler.runAfter(0, internal.activityFeed.record, {
            type: "bounty_resolved",
            bountyId: bounty._id,
            bountyTitle: bounty.title,
            actorName: agent?.name ?? "An agent",
          });
        }
      }
    }
  },
});

export const recordLogInternal = internalMutation({
  args: {
    verificationId: v.id("verifications"),
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
    agentId: v.optional(v.id("users")),
    claimId: v.optional(v.id("bountyClaims")),
    source: VERIFICATION_LOG_SOURCE_VALIDATOR,
    level: VERIFICATION_LOG_LEVEL_VALIDATOR,
    eventType: v.string(),
    gate: v.optional(v.string()),
    visibility: v.optional(v.union(v.literal("public"), v.literal("hidden"))),
    message: v.string(),
    detailsJson: v.optional(v.string()),
    createdAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("verificationLogs", {
      verificationId: args.verificationId,
      submissionId: args.submissionId,
      bountyId: args.bountyId,
      agentId: args.agentId,
      claimId: args.claimId,
      source: args.source,
      level: args.level,
      eventType: args.eventType,
      gate: args.gate,
      visibility: args.visibility,
      message: truncateForLog(args.message, VERIFICATION_LOG_MAX_MESSAGE_LEN),
      detailsJson: args.detailsJson
        ? truncateForLog(args.detailsJson, VERIFICATION_LOG_MAX_DETAILS_LEN)
        : undefined,
      createdAt: args.createdAt ?? Date.now(),
    });
  },
});

export const recordLogsBatchInternal = internalMutation({
  args: {
    logs: v.array(v.object({
      verificationId: v.id("verifications"),
      submissionId: v.id("submissions"),
      bountyId: v.id("bounties"),
      agentId: v.optional(v.id("users")),
      claimId: v.optional(v.id("bountyClaims")),
      source: VERIFICATION_LOG_SOURCE_VALIDATOR,
      level: VERIFICATION_LOG_LEVEL_VALIDATOR,
      eventType: v.string(),
      gate: v.optional(v.string()),
      visibility: v.optional(v.union(v.literal("public"), v.literal("hidden"))),
      message: v.string(),
      detailsJson: v.optional(v.string()),
      createdAt: v.optional(v.number()),
    })),
  },
  handler: async (ctx, args) => {
    for (const entry of args.logs) {
      await ctx.db.insert("verificationLogs", {
        verificationId: entry.verificationId,
        submissionId: entry.submissionId,
        bountyId: entry.bountyId,
        agentId: entry.agentId,
        claimId: entry.claimId,
        source: entry.source,
        level: entry.level,
        eventType: entry.eventType,
        gate: entry.gate,
        visibility: entry.visibility,
        message: truncateForLog(entry.message, VERIFICATION_LOG_MAX_MESSAGE_LEN),
        detailsJson: entry.detailsJson
          ? truncateForLog(entry.detailsJson, VERIFICATION_LOG_MAX_DETAILS_LEN)
          : undefined,
        createdAt: entry.createdAt ?? Date.now(),
      });
    }
  },
});

export const searchLogsInternal = internalQuery({
  args: {
    verificationId: v.optional(v.id("verifications")),
    submissionId: v.optional(v.id("submissions")),
    bountyId: v.optional(v.id("bounties")),
    agentId: v.optional(v.id("users")),
    source: v.optional(VERIFICATION_LOG_SOURCE_VALIDATOR),
    level: v.optional(VERIFICATION_LOG_LEVEL_VALIDATOR),
    eventType: v.optional(v.string()),
    gate: v.optional(v.string()),
    visibility: v.optional(v.union(v.literal("public"), v.literal("hidden"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await queryVerificationLogs(ctx, args);
  },
});

export const searchLogs = query({
  args: {
    verificationId: v.optional(v.id("verifications")),
    submissionId: v.optional(v.id("submissions")),
    bountyId: v.optional(v.id("bounties")),
    agentId: v.optional(v.id("users")),
    source: v.optional(VERIFICATION_LOG_SOURCE_VALIDATOR),
    level: v.optional(VERIFICATION_LOG_LEVEL_VALIDATOR),
    eventType: v.optional(v.string()),
    gate: v.optional(v.string()),
    visibility: v.optional(v.union(v.literal("public"), v.literal("hidden"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    let effectiveBountyId = args.bountyId;
    let effectiveSubmissionId = args.submissionId;

    if (!effectiveSubmissionId && args.verificationId) {
      const verification = await ctx.db.get(args.verificationId);
      if (!verification) return [];
      effectiveSubmissionId = verification.submissionId;
      effectiveBountyId = verification.bountyId;
    }

    if (!effectiveBountyId && effectiveSubmissionId) {
      const submission = await ctx.db.get(effectiveSubmissionId);
      if (!submission) return [];
      effectiveBountyId = submission.bountyId;
    }

    if (!effectiveBountyId) {
      if (user.role !== "admin") {
        throw new Error("Access denied: provide verificationId, submissionId, or bountyId");
      }
    } else {
      await requireBountyAccess(
        ctx,
        user._id,
        user.role,
        effectiveBountyId,
        effectiveSubmissionId,
      );
    }

    return await queryVerificationLogs(ctx, args);
  },
});

export const getFullStatus = internalQuery({
  args: { verificationId: v.id("verifications") },
  handler: async (ctx, args) => {
    const verification = await ctx.db.get(args.verificationId);
    if (!verification) return null;

    const gates = await ctx.db
      .query("sanityGates")
      .withIndex("by_verificationId", (q) =>
        q.eq("verificationId", args.verificationId)
      )
      .collect();

    const steps = await ctx.db
      .query("verificationSteps")
      .withIndex("by_verificationId", (q) =>
        q.eq("verificationId", args.verificationId)
      )
      .collect();

    const job = await ctx.db
      .query("verificationJobs")
      .withIndex("by_verificationId", (q) =>
        q.eq("verificationId", args.verificationId)
      )
      .first();

    return {
      ...verification,
      gates: gates.map((g) => ({
        gateType: g.gateType,
        tool: g.tool,
        status: g.status,
        issues: g.issues,
        details: g.detailsJson ? safeParseJson(g.detailsJson) : undefined,
      })),
      steps: steps.map((s) => ({
        scenarioName: s.scenarioName,
        featureName: s.featureName,
        status: s.status,
        executionTimeMs: s.executionTimeMs,
        output: s.output,
        stepNumber: s.stepNumber,
      })),
      job: job
        ? {
            status: job.status,
            currentGate: job.currentGate,
            queuedAt: job.queuedAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
          }
        : null,
    };
  },
});

/**
 * Agent-facing query for verification status.
 * Hidden Gherkin remains private, but hidden test failure feedback is returned.
 */
export const getAgentStatus = internalQuery({
  args: { verificationId: v.id("verifications") },
  handler: async (ctx, args) => {
    const verification = await ctx.db.get(args.verificationId);
    if (!verification) return null;

    const [gates, steps, job] = await Promise.all([
      ctx.db
        .query("sanityGates")
        .withIndex("by_verificationId", (q) =>
          q.eq("verificationId", args.verificationId)
        )
        .collect(),
      ctx.db
        .query("verificationSteps")
        .withIndex("by_verificationId", (q) =>
          q.eq("verificationId", args.verificationId)
        )
        .collect(),
      ctx.db
        .query("verificationJobs")
        .withIndex("by_verificationId", (q) =>
          q.eq("verificationId", args.verificationId)
        )
        .first(),
    ]);

    const allVisibleSteps = steps.map((s) => ({
        scenarioName: s.scenarioName,
        featureName: s.featureName,
        status: s.status,
        executionTimeMs: s.executionTimeMs,
        output: s.output,
        stepNumber: s.stepNumber,
        visibility: (s.visibility ?? "public") as "public" | "hidden",
      }));
    const hiddenSteps = steps.filter((s) => (s.visibility ?? "public") === "hidden");
    const hiddenFailureMechanisms = summarizeHiddenFailureMechanisms(
      hiddenSteps
        .filter((s) => s.status === "fail" || s.status === "error")
        .map((s) => s.output)
        .filter((output): output is string => typeof output === "string" && output.length > 0),
      hiddenSteps.filter((s) => s.status === "fail" || s.status === "error").length,
    );

    return {
      ...verification,
      gates: gates.map((g) => ({
        gateType: g.gateType,
        tool: g.tool,
        status: g.status,
        issues: g.issues,
        details: g.detailsJson ? safeParseJson(g.detailsJson) : undefined,
      })),
      steps: allVisibleSteps,
      hiddenSummary: {
        total: hiddenSteps.length,
        passed: hiddenSteps.filter((s) => s.status === "pass").length,
        failed: hiddenSteps.filter((s) => s.status === "fail" || s.status === "error").length,
        skipped: hiddenSteps.filter((s) => s.status === "skip").length,
      },
      hiddenFailureMechanisms,
      feedbackJson: verification.feedbackJson,
      job: job
        ? {
            status: job.status,
            currentGate: job.currentGate,
            queuedAt: job.queuedAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
          }
        : null,
    };
  },
});

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

const HIDDEN_MECHANISM_METADATA: Record<HiddenFailureMechanismKey, {
  label: string;
  guidance: string;
}> = {
  assertion_mismatch: {
    label: "Assertion mismatch",
    guidance: "Check edge-case outputs and strict equality assumptions.",
  },
  runtime_exception: {
    label: "Runtime exception",
    guidance: "Harden null/undefined handling and guard unsafe operations.",
  },
  module_or_path_error: {
    label: "Module or path error",
    guidance: "Verify import paths, file existence, and runtime entrypoints.",
  },
  timeout_or_hang: {
    label: "Timeout or hang",
    guidance: "Reduce algorithmic complexity and ensure async flows resolve.",
  },
  permission_or_filesystem: {
    label: "Permission or filesystem error",
    guidance: "Avoid privileged paths and handle file permissions safely.",
  },
  api_contract_or_validation: {
    label: "API contract or validation mismatch",
    guidance: "Validate request/response contracts and input validation branches.",
  },
  unknown_edge_case: {
    label: "Unknown edge case",
    guidance: "Add defensive checks around boundary conditions and error paths.",
  },
};

function summarizeHiddenFailureMechanisms(
  hiddenFailureOutputs: string[],
  hiddenFailures: number,
): HiddenFailureMechanism[] {
  if (hiddenFailures === 0) return [];

  const counts = new Map<HiddenFailureMechanismKey, number>();
  for (const output of hiddenFailureOutputs) {
    const mechanism = classifyHiddenFailureOutput(output);
    counts.set(mechanism, (counts.get(mechanism) ?? 0) + 1);
  }

  const accounted = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
  const unknownCount = hiddenFailures - accounted;
  if (unknownCount > 0) {
    counts.set("unknown_edge_case", (counts.get("unknown_edge_case") ?? 0) + unknownCount);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({
      key,
      count,
      label: HIDDEN_MECHANISM_METADATA[key].label,
      guidance: HIDDEN_MECHANISM_METADATA[key].guidance,
    }));
}

function classifyHiddenFailureOutput(output: string): HiddenFailureMechanismKey {
  const normalized = output.toLowerCase();

  if (/expected .* to|to equal|to deeply equal|assert|expected .* got|mismatch/i.test(normalized)) {
    return "assertion_mismatch";
  }
  if (/typeerror|referenceerror|syntaxerror|rangeerror|exception|panic|traceback|stack trace|segmentation fault/i.test(normalized)) {
    return "runtime_exception";
  }
  if (/cannot find module|module not found|no such file|enoent|importerror|cannot resolve/i.test(normalized)) {
    return "module_or_path_error";
  }
  if (/timeout|timed out|deadline exceeded|exceeded .*ms|hang/i.test(normalized)) {
    return "timeout_or_hang";
  }
  if (/eacces|eperm|permission denied|read-only file system|operation not permitted/i.test(normalized)) {
    return "permission_or_filesystem";
  }
  if (/validation|invalid input|schema|status code|http 4\d\d|unprocessable entity|bad request/i.test(normalized)) {
    return "api_contract_or_validation";
  }

  return "unknown_edge_case";
}

async function failVerificationDispatch(
  ctx: {
    runQuery: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>;
    runMutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>;
  },
  args: {
    verificationId: string;
    submissionId: string;
    bountyId: string;
  },
  reason: string,
) {
  const [submission, activeClaim] = await Promise.all([
    ctx.runQuery(internal.submissions.getByIdInternal, {
      submissionId: args.submissionId,
    }) as Promise<{ agentId?: string } | null>,
    ctx.runQuery(internal.bountyClaims.getActiveByClaim, {
      bountyId: args.bountyId,
    }) as Promise<{ _id: string } | null>,
  ]);

  await ctx.runMutation(internal.verifications.recordLogInternal, {
    verificationId: args.verificationId,
    submissionId: args.submissionId,
    bountyId: args.bountyId,
    agentId: submission?.agentId,
    claimId: activeClaim?._id,
    source: "verification_lifecycle",
    level: "error",
    eventType: "verification_dispatch_failed",
    message: reason,
    detailsJson: safeStringify({
      verificationId: args.verificationId,
      submissionId: args.submissionId,
      bountyId: args.bountyId,
    }),
  });

  await ctx.runMutation(internal.verifications.updateResult, {
    verificationId: args.verificationId,
    status: "failed",
    errorLog: reason,
    completedAt: Date.now(),
  });

  await ctx.runMutation(internal.submissions.updateStatus, {
    submissionId: args.submissionId,
    status: "failed",
  });
}

export const getByIdInternal = internalQuery({
  args: { verificationId: v.id("verifications") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.verificationId);
  },
});

/**
 * SECURITY (P2-5): Mark running verifications that have exceeded their
 * timeout as failed. Called periodically by cron.
 */
export const timeoutStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Query all running verifications
    const running = await ctx.db
      .query("verifications")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();

    let timedOutCount = 0;
    for (const v of running) {
      if (!v.startedAt) continue;
      const elapsedMs = now - v.startedAt;
      const timeoutMs = v.timeoutSeconds * 1000;

      // Add a 60s grace period beyond the configured timeout
      if (elapsedMs > timeoutMs + 60_000) {
        const submission = await ctx.db.get(v.submissionId);
        const activeClaim = await ctx.runQuery(internal.bountyClaims.getActiveByClaim, {
          bountyId: v.bountyId,
        });
        await ctx.db.insert("verificationLogs", {
          verificationId: v._id,
          submissionId: v.submissionId,
          bountyId: v.bountyId,
          agentId: submission?.agentId,
          claimId: activeClaim?._id,
          source: "verification_timeout",
          level: "error",
          eventType: "verification_timed_out_running",
          message: `Verification timed out after ${Math.round(elapsedMs / 1000)}s (limit: ${v.timeoutSeconds}s)`,
          detailsJson: JSON.stringify({
            elapsedMs,
            timeoutMs,
            status: v.status,
          }),
          createdAt: now,
        });

        await ctx.db.patch(v._id, {
          status: "failed",
          completedAt: now,
          errorLog: `Verification timed out after ${Math.round(elapsedMs / 1000)}s (limit: ${v.timeoutSeconds}s)`,
        });

        // Also fail the submission
        await ctx.db.patch(v.submissionId, { status: "failed" });
        timedOutCount++;
      }
    }

    // Also check pending verifications stuck for more than 10 minutes
    const pending = await ctx.db
      .query("verifications")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();

    for (const v of pending) {
      const age = now - v._creationTime;
      if (age > 10 * 60 * 1000) {
        const submission = await ctx.db.get(v.submissionId);
        const activeClaim = await ctx.runQuery(internal.bountyClaims.getActiveByClaim, {
          bountyId: v.bountyId,
        });
        await ctx.db.insert("verificationLogs", {
          verificationId: v._id,
          submissionId: v.submissionId,
          bountyId: v.bountyId,
          agentId: submission?.agentId,
          claimId: activeClaim?._id,
          source: "verification_timeout",
          level: "error",
          eventType: "verification_timed_out_pending",
          message: "Verification stuck in pending state for >10 minutes",
          detailsJson: JSON.stringify({
            ageMs: age,
            status: v.status,
          }),
          createdAt: now,
        });

        await ctx.db.patch(v._id, {
          status: "failed",
          completedAt: now,
          errorLog: "Verification stuck in pending state for >10 minutes",
        });
        await ctx.db.patch(v.submissionId, { status: "failed" });
        timedOutCount++;
      }
    }

    if (timedOutCount > 0) {
      console.log(`Timed out ${timedOutCount} stale verifications`);
    }
  },
});

/**
 * Diff-based verification entry point.
 * Dispatches a verification job that applies a diff to a clean clone
 * instead of checking out a specific commit.
 */
export const runVerificationFromDiff = internalAction({
  args: {
    verificationId: v.id("verifications"),
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
    baseRepoUrl: v.string(),
    baseCommitSha: v.string(),
    diffPatch: v.string(),
    sourceWorkspaceId: v.string(),
  },
  handler: async (ctx, args) => {
    const workerHost = process.env.WORKER_API_URL;
    const workerAuthToken = process.env.WORKER_SHARED_SECRET;

    if (!workerHost || !workerAuthToken) {
      const message = "Verification worker is not configured (WORKER_API_URL missing).";
      await failVerificationDispatch(
        ctx,
        {
          verificationId: args.verificationId,
          submissionId: args.submissionId,
          bountyId: args.bountyId,
        },
        message,
      );
      return;
    }

    await ctx.runAction(
      internal.pipelines.dispatchVerification.dispatchVerificationFromDiff,
      {
        verificationId: args.verificationId,
        submissionId: args.submissionId,
        bountyId: args.bountyId,
        baseRepoUrl: args.baseRepoUrl,
        baseCommitSha: args.baseCommitSha,
        diffPatch: args.diffPatch,
        sourceWorkspaceId: args.sourceWorkspaceId,
        workerHost,
        workerAuthToken,
      },
    );
  },
});

export const getBySubmissionInternal = internalQuery({
  args: { submissionId: v.id("submissions") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("verifications")
      .withIndex("by_submissionId", (q) =>
        q.eq("submissionId", args.submissionId)
      )
      .first();
  },
});

/** Get the latest verification for a bounty (most recently created) */
export const getLatestByBountyInternal = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("verifications")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .first();
  },
});

/** List all verifications for a bounty (for counting attempts) */
export const listByBountyInternal = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("verifications")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();
  },
});

/**
 * After verification passes, trigger payout if bounty uses Stripe escrow.
 */
export const triggerPayoutOnVerificationPass = internalAction({
  args: {
    verificationId: v.id("verifications"),
    bountyId: v.id("bounties"),
    submissionId: v.id("submissions"),
  },
  handler: async (ctx, args) => {
    try {
      // Guard: verify the verification actually passed
      const verification = await ctx.runQuery(internal.verifications.getByIdInternal, {
        verificationId: args.verificationId,
      });
      const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
        bountyId: args.bountyId,
      });
      if (!bounty) throw new Error("Bounty not found");

      const submission = await ctx.runQuery(
        internal.submissions.getByIdInternal,
        { submissionId: args.submissionId },
      );
      if (!submission) throw new Error("Submission not found");

      const activeClaimAtStart = await ctx.runQuery(internal.bountyClaims.getActiveByClaim, {
        bountyId: args.bountyId,
      });
      const logContext = {
        verificationId: args.verificationId,
        submissionId: args.submissionId,
        bountyId: args.bountyId,
        agentId: submission.agentId,
        claimId: activeClaimAtStart?._id,
      };
      const recordLifecycleLog = async (
        level: VerificationLogLevel,
        eventType: string,
        message: string,
        details?: unknown,
      ) => {
        try {
          await ctx.runMutation(internal.verifications.recordLogInternal, {
            ...logContext,
            source: "verification_lifecycle",
            level,
            eventType,
            message,
            detailsJson: safeStringify(details),
          });
        } catch (logErr) {
          console.error(
            `[verificationLogs] Failed to record ${eventType} for verification ${args.verificationId}: ${
              logErr instanceof Error ? logErr.message : String(logErr)
            }`,
          );
        }
      };

      if (!verification || verification.status !== "passed") {
        console.log(`[payout] Verification ${args.verificationId} is not passed, skipping`);
        await recordLifecycleLog(
          "warning",
          "payout_skipped_verification_not_passed",
          `Skipped payout flow because verification is not passed (${verification?.status ?? "missing"})`,
          { verificationStatus: verification?.status ?? null },
        );
        return;
      }

      await recordLifecycleLog(
        "info",
        "payout_flow_started",
        "Started payout/auto-PR flow after passed verification",
        {
          bountyPaymentMethod: bounty.paymentMethod,
          bountyEscrowStatus: bounty.escrowStatus,
          isTestBounty: bounty.isTestBounty,
        },
      );

      let autoPrUrl: string | null = null;
      try {
        const workerUrl = process.env.WORKER_API_URL;
        const workerSecret = process.env.WORKER_SHARED_SECRET;
        const workspace = await ctx.runQuery(internal.devWorkspaces.getActiveByAgentAndBounty, {
          agentId: submission.agentId,
          bountyId: args.bountyId,
        });

        if (!workerUrl || !workerSecret || !workspace?.workerHost) {
          await recordLifecycleLog(
            "warning",
            "auto_pr_skipped_missing_worker_context",
            "Skipped auto-PR publish because worker URL/secret or active workspace host was unavailable",
            {
              hasWorkerUrl: Boolean(workerUrl),
              hasWorkerSecret: Boolean(workerSecret),
              hasWorkspace: Boolean(workspace),
              hasWorkspaceHost: Boolean(workspace?.workerHost),
            },
          );
        } else {
          const diffResponse = await fetchWithRetry(`${workspace.workerHost}/api/workspace/diff`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${workerSecret}`,
            },
            body: JSON.stringify({
              workspaceId: workspace.workspaceId,
            }),
          });

          if (diffResponse.ok) {
            const diffPayload = await diffResponse.json() as {
              diffPatch?: string;
              hasChanges?: boolean;
            };

            if (diffPayload.hasChanges && diffPayload.diffPatch) {
              await recordLifecycleLog(
                "info",
                "auto_pr_diff_ready",
                "Workspace diff contained changes and was eligible for auto-PR publish",
                { workspaceId: workspace.workspaceId, baseCommitSha: workspace.baseCommitSha },
              );

              const repoConnection = await ctx.runQuery(
                internal.repoConnections.getByBountyIdInternal,
                { bountyId: args.bountyId },
              );
              const repoAuthTokenResult = await resolveGitHubTokenForRepo({
                repositoryUrl: workspace.repositoryUrl,
                preferredInstallationId: repoConnection?.githubInstallationId,
                writeAccess: true,
              });
              if (requiresGitHubInstallationToken(workspace.repositoryUrl) && !repoAuthTokenResult?.token) {
                throw new Error(
                  "GitHub installation token is required for auto-PR publish. Install/repair the GitHub App for this repository.",
                );
              }
              if (
                repoConnection &&
                repoAuthTokenResult &&
                (repoAuthTokenResult.installationId !== repoConnection.githubInstallationId ||
                  repoAuthTokenResult.accountLogin !== repoConnection.githubInstallationAccountLogin)
              ) {
                await ctx.runMutation(internal.repoConnections.updateGitHubInstallation, {
                  repoConnectionId: repoConnection._id,
                  githubInstallationId: repoAuthTokenResult.installationId,
                  githubInstallationAccountLogin: repoAuthTokenResult.accountLogin,
                });
              }
              const baseBranch = repoConnection?.defaultBranch ?? "main";
              const featureBranchName = `arcagent/verified-${String(args.verificationId).slice(-8)}`;
              const prTitle = `[arcagent] ${bounty.title}`;
              const prBody = [
                "Automated PR created from a passed verification run.",
                "",
                `- Bounty ID: ${args.bountyId}`,
                `- Submission ID: ${args.submissionId}`,
                `- Verification ID: ${args.verificationId}`,
              ].join("\n");

              const publishResponse = await fetchWithRetry(`${workerUrl}/api/verify/publish-pr`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${workerSecret}`,
                },
                body: JSON.stringify({
                  verificationId: args.verificationId,
                  submissionId: args.submissionId,
                  bountyId: args.bountyId,
                  repoUrl: workspace.repositoryUrl,
                  repoAuthToken: repoAuthTokenResult?.token,
                  baseCommitSha: workspace.baseCommitSha,
                  baseBranch,
                  featureBranchName,
                  diffPatch: diffPayload.diffPatch,
                  prTitle,
                  prBody,
                }),
              });

              if (publishResponse.ok) {
                const publishPayload = await publishResponse.json() as {
                  pullRequestUrl?: string | null;
                  featureBranchName?: string;
                  featureBranchRepo?: string;
                };
                autoPrUrl = publishPayload.pullRequestUrl ?? null;
                if (publishPayload.featureBranchName && publishPayload.featureBranchRepo) {
                  const activeClaim = await ctx.runQuery(internal.bountyClaims.getActiveByClaim, {
                    bountyId: args.bountyId,
                  });
                  if (activeClaim) {
                    await ctx.runMutation(internal.bountyClaims.updateBranchInfo, {
                      claimId: activeClaim._id,
                      featureBranchName: publishPayload.featureBranchName,
                      featureBranchRepo: publishPayload.featureBranchRepo,
                    });
                  }
                }
                if (autoPrUrl) {
                  console.log(`[autopr] Created PR ${autoPrUrl} for verification ${args.verificationId}`);
                } else {
                  console.log(`[autopr] PR publish completed without URL for verification ${args.verificationId}`);
                }
                await recordLifecycleLog(
                  "info",
                  "auto_pr_publish_succeeded",
                  autoPrUrl
                    ? `Auto-PR publish succeeded with URL ${autoPrUrl}`
                    : "Auto-PR publish succeeded without a pull request URL in response",
                  {
                    pullRequestUrl: autoPrUrl,
                    featureBranchName: publishPayload.featureBranchName,
                    featureBranchRepo: publishPayload.featureBranchRepo,
                  },
                );
              } else {
                const reason = await publishResponse.text().catch(() => "");
                console.error(
                  `[autopr] Failed for verification ${args.verificationId}: ${publishResponse.status} ${reason.slice(0, 300)}`,
                );
                await recordLifecycleLog(
                  "error",
                  "auto_pr_publish_failed_response",
                  `Auto-PR publish failed with HTTP ${publishResponse.status}`,
                  { status: publishResponse.status, reason: reason.slice(0, 300) },
                );
              }
            } else {
              await recordLifecycleLog(
                "warning",
                "auto_pr_skipped_no_changes",
                "Skipped auto-PR publish because workspace diff had no staged changes",
                {
                  hasChanges: diffPayload.hasChanges ?? false,
                  hasDiffPatch: Boolean(diffPayload.diffPatch),
                },
              );
            }
          } else {
            const reason = await diffResponse.text().catch(() => "");
            console.error(
              `[autopr] Failed to fetch workspace diff for verification ${args.verificationId}: ${diffResponse.status} ${reason.slice(0, 300)}`,
            );
            await recordLifecycleLog(
              "error",
              "auto_pr_diff_fetch_failed",
              `Failed to fetch workspace diff for auto-PR (HTTP ${diffResponse.status})`,
              { status: diffResponse.status, reason: reason.slice(0, 300) },
            );
          }
        }
      } catch (err) {
        console.error(
          `[autopr] Error for verification ${args.verificationId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await recordLifecycleLog(
          "error",
          "auto_pr_publish_exception",
          err instanceof Error ? err.message : String(err),
        );
      }

      // Test bounties complete the normal lifecycle but never move money.
      if (bounty.isTestBounty) {
        await ctx.runMutation(internal.bounties.updateStatusInternal, {
          bountyId: args.bountyId,
          status: "completed",
        });

        const activeClaim = await ctx.runQuery(internal.bountyClaims.getActiveByClaim, {
          bountyId: args.bountyId,
        });
        if (activeClaim) {
          await ctx.runMutation(internal.bountyClaims.markCompleted, {
            claimId: activeClaim._id,
          });
          await ctx.scheduler.runAfter(0, internal.agentStats.recomputeForAgent, {
            agentId: activeClaim.agentId,
          });
        }

        await ctx.runMutation(internal.agentHellos.recordFromVerification, {
          bountyId: args.bountyId,
          submissionId: args.submissionId,
          verificationId: args.verificationId,
          agentId: submission.agentId,
          agentIdentifier: bounty.testBountyAgentIdentifier ?? String(submission.agentId),
          message: autoPrUrl
            ? `hello from ${bounty.testBountyAgentIdentifier ?? String(submission.agentId)} (PR: ${autoPrUrl})`
            : `hello from ${bounty.testBountyAgentIdentifier ?? String(submission.agentId)}`,
        });

        await ctx.runAction(internal.stripe.checkPayoutReadiness, {
          bountyId: args.bountyId,
          agentId: submission.agentId,
          verificationId: args.verificationId,
        });
        await recordLifecycleLog(
          "info",
          "test_bounty_completed_no_payout",
          "Completed test bounty flow without payout and recorded readiness handshake",
          { autoPrUrl },
        );

        console.log(
          `[payout] Test bounty ${args.bountyId} completed without payout; readiness handshake recorded`
        );
        return;
      }

      // Only process Stripe payouts for funded escrows
      if (bounty.paymentMethod !== "stripe" || bounty.escrowStatus !== "funded") {
        console.log(
          `[payout] Skipping payout for bounty ${args.bountyId}: method=${bounty.paymentMethod}, escrow=${bounty.escrowStatus}`
        );
        await recordLifecycleLog(
          "info",
          "payout_skipped_non_stripe_or_unfunded",
          "Skipped payout because bounty is not stripe-funded",
          { paymentMethod: bounty.paymentMethod, escrowStatus: bounty.escrowStatus },
        );
        return;
      }

      // Guard: prevent duplicate payment records per bounty
      const existingPayment = await ctx.runQuery(internal.payments.getByBountyInternal, {
        bountyId: args.bountyId,
      });
      if (existingPayment && existingPayment.status !== "failed") {
        console.log(`[payout] Payment already exists for bounty ${args.bountyId}, skipping`);
        await recordLifecycleLog(
          "info",
          "payout_skipped_existing_payment",
          "Skipped payout because a non-failed payment record already exists",
          { existingPaymentId: existingPayment._id, existingPaymentStatus: existingPayment.status },
        );
        return;
      }

      // Calculate fee breakdown for payment record
      const grossCents = Math.round(bounty.reward * 100);
      const feeCents = bounty.platformFeeCents ?? Math.round(grossCents * PLATFORM_FEE_RATE);
      const solverCents = grossCents - feeCents;

      // Initiate payment record with fee breakdown
      const paymentId = await ctx.runMutation(internal.payments.initiate, {
        bountyId: args.bountyId,
        recipientId: submission.agentId,
        amount: bounty.reward,
        currency: bounty.rewardCurrency,
        method: "stripe",
        platformFeeCents: feeCents,
        solverAmountCents: solverCents,
      });

      // Release escrow
      await ctx.runAction(internal.stripe.releaseEscrow, {
        bountyId: args.bountyId,
        recipientUserId: submission.agentId,
        paymentId,
      });

      // Mark bounty as completed
      await ctx.runMutation(internal.bounties.updateStatusInternal, {
        bountyId: args.bountyId,
        status: "completed",
      });

      // Mark the active claim as completed.
      const activeClaim = await ctx.runQuery(internal.bountyClaims.getActiveByClaim, {
        bountyId: args.bountyId,
      });
      if (activeClaim) {
        await ctx.runMutation(internal.bountyClaims.markCompleted, {
          claimId: activeClaim._id,
        });

        // Schedule agent stats recomputation after completion
        await ctx.scheduler.runAfter(0, internal.agentStats.recomputeForAgent, {
          agentId: activeClaim.agentId,
        });
      }

      console.log(
        `[payout] Escrow released for bounty ${args.bountyId} to user ${submission.agentId}`
      );
      await recordLifecycleLog(
        "info",
        "payout_released_success",
        "Released escrow and completed bounty payout flow",
        { recipientId: submission.agentId, paymentId },
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown payout error";
      console.error(
        `[payout] Failed for bounty ${args.bountyId}: ${errorMessage}`
      );
      try {
        const submissionForLog = await ctx.runQuery(
          internal.submissions.getByIdInternal,
          { submissionId: args.submissionId },
        );
        const activeClaim = await ctx.runQuery(internal.bountyClaims.getActiveByClaim, {
          bountyId: args.bountyId,
        });
        await ctx.runMutation(internal.verifications.recordLogInternal, {
          verificationId: args.verificationId,
          submissionId: args.submissionId,
          bountyId: args.bountyId,
          agentId: submissionForLog?.agentId,
          claimId: activeClaim?._id,
          source: "verification_lifecycle",
          level: "error",
          eventType: "payout_flow_failed",
          message: errorMessage,
          detailsJson: safeStringify({ errorMessage }),
        });
      } catch (logErr) {
        console.error(
          `[verificationLogs] Failed to record payout failure for verification ${args.verificationId}: ${
            logErr instanceof Error ? logErr.message : String(logErr)
          }`,
        );
      }

      const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
        bountyId: args.bountyId,
      });
      if (bounty?.isTestBounty) {
        return;
      }

      // Record the failure as a payment record so retryFailedPayouts can pick it up
      const submission = await ctx.runQuery(
        internal.submissions.getByIdInternal,
        { submissionId: args.submissionId }
      );
      if (submission) {
        const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
          bountyId: args.bountyId,
        });
        if (bounty) {
          const existingPayment = await ctx.runQuery(internal.payments.getByBountyInternal, {
            bountyId: args.bountyId,
          });
          if (!existingPayment) {
            const grossCents = Math.round(bounty.reward * 100);
            const feeCents = bounty.platformFeeCents ?? Math.round(grossCents * PLATFORM_FEE_RATE);
            const solverCents = grossCents - feeCents;
            await ctx.runMutation(internal.payments.initiate, {
              bountyId: args.bountyId,
              recipientId: submission.agentId,
              amount: bounty.reward,
              currency: bounty.rewardCurrency,
              method: "stripe",
              platformFeeCents: feeCents,
              solverAmountCents: solverCents,
            });
            // Mark it as failed immediately
            const newPayment = await ctx.runQuery(internal.payments.getByBountyInternal, {
              bountyId: args.bountyId,
            });
            if (newPayment) {
              await ctx.runMutation(internal.payments.updateStatus, {
                paymentId: newPayment._id,
                status: "failed",
              });
            }
          }
        }
      }
    }
  },
});

/**
 * Main verification entry point.
 * Dispatches the verification job to the external worker service.
 */
export const runVerification = internalAction({
  args: {
    verificationId: v.id("verifications"),
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
  },
  handler: async (ctx, args) => {
    const workerHost = process.env.WORKER_API_URL;
    const workerAuthToken = process.env.WORKER_SHARED_SECRET;

    if (!workerHost || !workerAuthToken) {
      const message = "Verification worker is not configured (WORKER_API_URL missing).";
      await failVerificationDispatch(
        ctx,
        {
          verificationId: args.verificationId,
          submissionId: args.submissionId,
          bountyId: args.bountyId,
        },
        message,
      );
      return;
    }

    await ctx.runAction(
      internal.pipelines.dispatchVerification.dispatchVerification,
      {
        verificationId: args.verificationId,
        submissionId: args.submissionId,
        bountyId: args.bountyId,
        workerHost,
        workerAuthToken,
      }
    );
  },
});
