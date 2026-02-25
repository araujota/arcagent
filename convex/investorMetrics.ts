import { query } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth } from "./lib/utils";

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(timestampMs: number): number {
  const d = new Date(timestampMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function dayLabelUtc(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function isInRange(timestampMs: number | undefined, startMs: number, endMs: number): boolean {
  if (timestampMs === undefined) return false;
  return timestampMs >= startMs && timestampMs < endMs;
}

function coalesceTime(
  explicitTimestamp: number | undefined,
  creationTimestamp: number,
): number {
  return explicitTimestamp ?? creationTimestamp;
}

async function requireAdmin(ctx: any) {
  const user = requireAuth(await getCurrentUser(ctx));
  if (user.role !== "admin") {
    throw new Error("Admin access required");
  }
  return user;
}

function buildDayWindows(days: number, nowMs: number) {
  const clampedDays = Math.max(1, Math.min(365, days));
  const todayStartMs = startOfUtcDay(nowMs);
  const windows: Array<{ startMs: number; endMs: number; date: string }> = [];
  for (let i = clampedDays - 1; i >= 0; i--) {
    const startMs = todayStartMs - i * DAY_MS;
    windows.push({
      startMs,
      endMs: startMs + DAY_MS,
      date: dayLabelUtc(startMs),
    });
  }
  return windows;
}

export const getSnapshot = query({
  args: {
    windowDays: v.optional(v.number()),
    nowMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const nowMs = args.nowMs ?? Date.now();
    const windowDays = Math.max(1, Math.min(365, args.windowDays ?? 30));
    const todayStartMs = startOfUtcDay(nowMs);
    const weekStartMs = todayStartMs - 6 * DAY_MS;
    const windowStartMs = todayStartMs - (windowDays - 1) * DAY_MS;

    const [users, bounties, claims, submissions, payments, apiKeys, activityFeed] =
      (await Promise.all([
        ctx.db.query("users").collect(),
        ctx.db.query("bounties").collect(),
        ctx.db.query("bountyClaims").collect(),
        ctx.db.query("submissions").collect(),
        ctx.db.query("payments").collect(),
        ctx.db.query("apiKeys").collect(),
        ctx.db
          .query("activityFeed")
          .withIndex("by_createdAt", (q: any) => q.gte("createdAt", weekStartMs))
          .collect(),
      ])) as Array<any[]>;

    const userRoleById = new Map<string, "creator" | "agent" | "admin">();
    for (const user of users) {
      userRoleById.set(String(user._id), user.role);
    }

    const activeToday = new Set<string>();
    const activeWindow = new Set<string>();
    const activeWeek = new Set<string>();
    const activeAgentsToday = new Set<string>();

    const markUserActive = (userId: string, timestampMs: number) => {
      if (isInRange(timestampMs, todayStartMs, todayStartMs + DAY_MS)) {
        activeToday.add(userId);
        if (userRoleById.get(userId) === "agent") activeAgentsToday.add(userId);
      }
      if (isInRange(timestampMs, weekStartMs, todayStartMs + DAY_MS)) {
        activeWeek.add(userId);
      }
      if (isInRange(timestampMs, windowStartMs, todayStartMs + DAY_MS)) {
        activeWindow.add(userId);
      }
    };

    for (const bounty of bounties) {
      markUserActive(String(bounty.creatorId), bounty._creationTime);
    }
    for (const claim of claims) {
      markUserActive(String(claim.agentId), claim.claimedAt);
    }
    for (const submission of submissions) {
      markUserActive(String(submission.agentId), submission._creationTime);
    }
    for (const payment of payments) {
      markUserActive(String(payment.recipientId), payment.createdAt);
    }
    for (const key of apiKeys) {
      if (key.lastUsedAt !== undefined) {
        markUserActive(String(key.userId), key.lastUsedAt);
      }
    }

    const bountiesCreatedToday = bounties.filter((b) =>
      isInRange(b._creationTime, todayStartMs, todayStartMs + DAY_MS)
    );
    const bountiesCreatedWindow = bounties.filter((b) =>
      isInRange(b._creationTime, windowStartMs, todayStartMs + DAY_MS)
    );
    const claimsToday = claims.filter((c) =>
      isInRange(c.claimedAt, todayStartMs, todayStartMs + DAY_MS)
    );
    const submissionsToday = submissions.filter((s) =>
      isInRange(s._creationTime, todayStartMs, todayStartMs + DAY_MS)
    );

    const completedPayments = payments.filter((p) => p.status === "completed");
    const payoutsToday = completedPayments.filter((p) =>
      isInRange(p.createdAt, todayStartMs, todayStartMs + DAY_MS)
    );

    const activityToday = activityFeed.filter((e) =>
      isInRange(e.createdAt, todayStartMs, todayStartMs + DAY_MS)
    );
    const activityCountsToday: Record<string, number> = {};
    for (const event of activityToday) {
      activityCountsToday[event.type] = (activityCountsToday[event.type] ?? 0) + 1;
    }

    const totalPayoutUsd = completedPayments.reduce((sum, p) => sum + p.amount, 0);
    const totalPlatformFeesUsd = completedPayments.reduce(
      (sum, p) => sum + (p.platformFeeCents ?? 0) / 100,
      0,
    );

    return {
      asOfMs: nowMs,
      windowDays,
      totals: {
        users: users.length,
        agents: users.filter((u) => u.role === "agent").length,
        creators: users.filter((u) => u.role === "creator").length,
        admins: users.filter((u) => u.role === "admin").length,
        bounties: bounties.length,
        openBounties: bounties.filter(
          (b) => b.status === "active" || b.status === "in_progress",
        ).length,
        completedBounties: bounties.filter((b) => b.status === "completed").length,
        bountyRewardVolumeUsd: bounties.reduce((sum, b) => sum + b.reward, 0),
        payoutsCompletedCount: completedPayments.length,
        payoutsCompletedUsd: totalPayoutUsd,
        platformFeesCollectedUsd: totalPlatformFeesUsd,
        activeClaims: claims.filter((c) => c.status === "active").length,
      },
      growth: {
        newUsersToday: users.filter((u) =>
          isInRange(u._creationTime, todayStartMs, todayStartMs + DAY_MS)
        ).length,
        newAgentsToday: users.filter(
          (u) =>
            u.role === "agent" &&
            isInRange(u._creationTime, todayStartMs, todayStartMs + DAY_MS),
        ).length,
        newUsersInWindow: users.filter((u) =>
          isInRange(u._creationTime, windowStartMs, todayStartMs + DAY_MS)
        ).length,
      },
      activity: {
        dau: activeToday.size,
        dailyActiveAgents: activeAgentsToday.size,
        wau: activeWeek.size,
        mau: activeWindow.size,
        bountiesCreatedToday: bountiesCreatedToday.length,
        bountyVolumeCreatedTodayUsd: bountiesCreatedToday.reduce(
          (sum, b) => sum + b.reward,
          0,
        ),
        bountiesCreatedInWindow: bountiesCreatedWindow.length,
        claimsStartedToday: claimsToday.length,
        submissionsToday: submissionsToday.length,
        payoutsTodayCount: payoutsToday.length,
        payoutsTodayUsd: payoutsToday.reduce((sum, p) => sum + p.amount, 0),
        activityEventsToday: activityCountsToday,
      },
    };
  },
});

export const getDailySeries = query({
  args: {
    days: v.optional(v.number()),
    nowMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const nowMs = args.nowMs ?? Date.now();
    const windows = buildDayWindows(args.days ?? 30, nowMs);
    const earliestStartMs = windows[0]!.startMs;
    const lastEndMs = windows[windows.length - 1]!.endMs;

    const [users, bounties, claims, submissions, payments, apiKeys, activityFeed] =
      (await Promise.all([
        ctx.db.query("users").collect(),
        ctx.db.query("bounties").collect(),
        ctx.db.query("bountyClaims").collect(),
        ctx.db.query("submissions").collect(),
        ctx.db.query("payments").collect(),
        ctx.db.query("apiKeys").collect(),
        ctx.db
          .query("activityFeed")
          .withIndex("by_createdAt", (q: any) => q.gte("createdAt", earliestStartMs))
          .collect(),
      ])) as Array<any[]>;

    const userRoleById = new Map<string, "creator" | "agent" | "admin">();
    for (const user of users) {
      userRoleById.set(String(user._id), user.role);
    }

    return windows.map(({ date, startMs, endMs }) => {
      const dauUsers = new Set<string>();
      const dailyActiveAgents = new Set<string>();

      const markUserActive = (userId: string, timestampMs: number) => {
        if (!isInRange(timestampMs, startMs, endMs)) return;
        dauUsers.add(userId);
        if (userRoleById.get(userId) === "agent") {
          dailyActiveAgents.add(userId);
        }
      };

      const newUsers = users.filter((u) =>
        isInRange(u._creationTime, startMs, endMs)
      );
      const newAgents = newUsers.filter((u) => u.role === "agent");
      const newCreators = newUsers.filter((u) => u.role === "creator");

      const bountiesCreated = bounties.filter((b) =>
        isInRange(b._creationTime, startMs, endMs)
      );
      const claimsStarted = claims.filter((c) =>
        isInRange(c.claimedAt, startMs, endMs)
      );
      const submissionsCreated = submissions.filter((s) =>
        isInRange(s._creationTime, startMs, endMs)
      );
      const payoutsCompleted = payments.filter(
        (p) => p.status === "completed" && isInRange(p.createdAt, startMs, endMs),
      );
      const events = activityFeed.filter((e) =>
        isInRange(coalesceTime(e.createdAt, e._creationTime), startMs, endMs)
      );

      for (const bounty of bountiesCreated) {
        markUserActive(String(bounty.creatorId), bounty._creationTime);
      }
      for (const claim of claimsStarted) {
        markUserActive(String(claim.agentId), claim.claimedAt);
      }
      for (const submission of submissionsCreated) {
        markUserActive(String(submission.agentId), submission._creationTime);
      }
      for (const payout of payoutsCompleted) {
        markUserActive(String(payout.recipientId), payout.createdAt);
      }
      for (const key of apiKeys) {
        if (
          key.lastUsedAt !== undefined &&
          isInRange(key.lastUsedAt, startMs, endMs) &&
          key.lastUsedAt < lastEndMs
        ) {
          markUserActive(String(key.userId), key.lastUsedAt);
        }
      }

      const activityEvents: Record<string, number> = {};
      for (const event of events) {
        activityEvents[event.type] = (activityEvents[event.type] ?? 0) + 1;
      }

      return {
        date,
        users: {
          newUsers: newUsers.length,
          newAgents: newAgents.length,
          newCreators: newCreators.length,
          dau: dauUsers.size,
          dailyActiveAgents: dailyActiveAgents.size,
        },
        bounties: {
          createdCount: bountiesCreated.length,
          createdRewardUsd: bountiesCreated.reduce((sum, b) => sum + b.reward, 0),
          claimsStartedCount: claimsStarted.length,
          submissionsCount: submissionsCreated.length,
        },
        payouts: {
          completedCount: payoutsCompleted.length,
          completedUsd: payoutsCompleted.reduce((sum, p) => sum + p.amount, 0),
          platformFeesUsd: payoutsCompleted.reduce(
            (sum, p) => sum + (p.platformFeeCents ?? 0) / 100,
            0,
          ),
        },
        activityEvents,
      };
    });
  },
});
