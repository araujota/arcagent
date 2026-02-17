/**
 * Convex functions for workspace crash reports.
 *
 * Records crash events from the worker's crash reporter and provides
 * query functions for debugging and observability.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Record a new workspace crash report.
 *
 * Called by the worker via the HTTP endpoint POST /api/workspace/crash-report.
 * Also updates the associated devWorkspace status to "error" if it exists.
 */
export const recordCrashReport = internalMutation({
  args: {
    workspaceId: v.string(),
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
    claimId: v.id("bountyClaims"),
    vmId: v.string(),
    workerInstanceId: v.string(),
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
    errorMessage: v.string(),
    lastKnownStatus: v.string(),
    vmUptimeMs: v.optional(v.number()),
    lastHeartbeatAt: v.optional(v.number()),
    lastActivityAt: v.optional(v.number()),
    resourceUsage: v.optional(
      v.object({
        cpuPercent: v.optional(v.number()),
        memoryMb: v.optional(v.number()),
        diskMb: v.optional(v.number()),
      }),
    ),
    recovered: v.boolean(),
    recoveryAction: v.optional(
      v.union(
        v.literal("reconnected"),
        v.literal("reprovisioned"),
        v.literal("abandoned"),
      ),
    ),
    hostMetrics: v.optional(
      v.object({
        totalActiveVMs: v.optional(v.number()),
        hostMemoryUsedPercent: v.optional(v.number()),
        hostCpuUsedPercent: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    // Insert crash report
    await ctx.db.insert("workspaceCrashReports", {
      workspaceId: args.workspaceId,
      bountyId: args.bountyId,
      agentId: args.agentId,
      claimId: args.claimId,
      vmId: args.vmId,
      workerInstanceId: args.workerInstanceId,
      crashType: args.crashType,
      errorMessage: args.errorMessage,
      lastKnownStatus: args.lastKnownStatus,
      vmUptimeMs: args.vmUptimeMs,
      lastHeartbeatAt: args.lastHeartbeatAt,
      lastActivityAt: args.lastActivityAt,
      resourceUsage: args.resourceUsage,
      recovered: args.recovered,
      recoveryAction: args.recoveryAction,
      hostMetrics: args.hostMetrics,
      createdAt: Date.now(),
    });

    // Update the devWorkspace status to "error" if it's not already destroyed
    const workspace = await ctx.db
      .query("devWorkspaces")
      .withIndex("by_workspaceId", (q) =>
        q.eq("workspaceId", args.workspaceId),
      )
      .first();

    if (workspace && workspace.status !== "destroyed") {
      await ctx.db.patch(workspace._id, {
        status: "error",
        errorMessage: `Crash: ${args.crashType} — ${args.errorMessage.slice(0, 200)}`,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get crash reports for a specific bounty (latest 20).
 *
 * Used by admin dashboards and debugging tools to review crash history.
 */
export const getCrashReports = internalQuery({
  args: {
    bountyId: v.id("bounties"),
  },
  handler: async (ctx, args) => {
    const reports = await ctx.db
      .query("workspaceCrashReports")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .take(20);

    return reports;
  },
});

/**
 * Get crash reports for a specific workspace.
 *
 * Returns all crash reports associated with a workspace ID, ordered by
 * creation time (newest first).
 */
export const getCrashReportsByWorkspace = internalQuery({
  args: {
    workspaceId: v.string(),
  },
  handler: async (ctx, args) => {
    const reports = await ctx.db
      .query("workspaceCrashReports")
      .withIndex("by_workspaceId", (q) =>
        q.eq("workspaceId", args.workspaceId),
      )
      .order("desc")
      .collect();

    return reports;
  },
});
