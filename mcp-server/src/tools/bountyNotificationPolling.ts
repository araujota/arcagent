import { callConvex } from "../convex/client";

type AgentStatsResponse = {
  stats: {
    tier: string;
  } | null;
};

type BountyListResponse = {
  bounties: Array<{
    _id: string;
    title: string;
    reward: number;
    rewardCurrency: string;
    requiredTier?: string;
  }>;
};

export interface BountyPollingAlert {
  bountyId: string;
  title: string;
  message: string;
  createdAt: number;
}

interface ActiveBountyPoller {
  userId: string;
  apiKey: string;
  minReward: number;
  pollIntervalSeconds: number;
  knownBountyIds: Set<string>;
  timer: ReturnType<typeof setInterval>;
}

const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const MIN_POLL_INTERVAL_SECONDS = 15;
const MAX_POLL_INTERVAL_SECONDS = 300;

const activePollers = new Map<string, ActiveBountyPoller>();
const pendingAlerts = new Map<string, BountyPollingAlert[]>();

function clampPollIntervalSeconds(value?: number): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_POLL_INTERVAL_SECONDS;
  }
  return Math.max(
    MIN_POLL_INTERVAL_SECONDS,
    Math.min(MAX_POLL_INTERVAL_SECONDS, Math.floor(value)),
  );
}

async function getAgentTier(userId: string, apiKey: string): Promise<string | null> {
  const result = await callConvex<AgentStatsResponse>(
    "/api/mcp/agents/my-stats",
    { userId },
    { authToken: apiKey },
  );
  return result.stats?.tier ?? null;
}

async function listMatchingBounties(
  apiKey: string,
  minReward: number,
): Promise<BountyListResponse["bounties"]> {
  const result = await callConvex<BountyListResponse>(
    "/api/mcp/bounties/list",
    {
      status: "active",
      minReward,
      limit: 100,
    },
    { authToken: apiKey },
  );
  return result.bounties;
}

function enqueueAlert(userId: string, alert: BountyPollingAlert): void {
  const alerts = pendingAlerts.get(userId) ?? [];
  alerts.push(alert);
  pendingAlerts.set(userId, alerts);
}

function formatThresholdMessage(
  bounty: BountyListResponse["bounties"][number],
  minReward: number,
): string {
  const tierInfo = bounty.requiredTier ? ` Required tier: ${bounty.requiredTier}+.` : "";
  return (
    `Bounty "${bounty.title}" matches your watch threshold of ${minReward} ${bounty.rewardCurrency}. ` +
    `Reward: ${bounty.reward} ${bounty.rewardCurrency}.${tierInfo}`
  );
}

export async function startBountyNotificationPolling(args: {
  userId: string;
  apiKey: string;
  minReward: number;
  pollIntervalSeconds?: number;
}): Promise<{
  tier: string;
  minReward: number;
  pollIntervalSeconds: number;
  seededMatchCount: number;
}> {
  const tier = await getAgentTier(args.userId, args.apiKey);
  if (!tier || tier === "unranked") {
    throw new Error(
      "Bounty polling alerts are only available to tiered agents with enough completed platform history.",
    );
  }

  const pollIntervalSeconds = clampPollIntervalSeconds(args.pollIntervalSeconds);
  const baselineBounties = await listMatchingBounties(args.apiKey, args.minReward);

  stopBountyNotificationPolling(args.userId);

  const poller: ActiveBountyPoller = {
    userId: args.userId,
    apiKey: args.apiKey,
    minReward: args.minReward,
    pollIntervalSeconds,
    knownBountyIds: new Set(baselineBounties.map((bounty) => bounty._id)),
    timer: setInterval(() => undefined, pollIntervalSeconds * 1000),
  };

  clearInterval(poller.timer);
  poller.timer = setInterval(() => {
    void pollBountyNotificationWatch(args.userId);
  }, pollIntervalSeconds * 1000);
  poller.timer.unref?.();
  activePollers.set(args.userId, poller);

  return {
    tier,
    minReward: args.minReward,
    pollIntervalSeconds,
    seededMatchCount: baselineBounties.length,
  };
}

export async function pollBountyNotificationWatch(userId: string): Promise<void> {
  const poller = activePollers.get(userId);
  if (!poller) {
    return;
  }

  try {
    const tier = await getAgentTier(poller.userId, poller.apiKey);
    if (!tier || tier === "unranked") {
      stopBountyNotificationPolling(userId);
      return;
    }

    const matchingBounties = await listMatchingBounties(poller.apiKey, poller.minReward);
    for (const bounty of matchingBounties) {
      if (poller.knownBountyIds.has(bounty._id)) {
        continue;
      }
      poller.knownBountyIds.add(bounty._id);
      enqueueAlert(userId, {
        bountyId: bounty._id,
        title: `Threshold match: ${bounty.title}`,
        message: formatThresholdMessage(bounty, poller.minReward),
        createdAt: Date.now(),
      });
    }
  } catch {
    return;
  }
}

export function stopBountyNotificationPolling(userId: string): boolean {
  const poller = activePollers.get(userId);
  if (!poller) {
    return false;
  }
  clearInterval(poller.timer);
  activePollers.delete(userId);
  return true;
}

export function hasBountyNotificationPolling(userId: string): boolean {
  return activePollers.has(userId);
}

export function drainBountyNotificationAlerts(userId: string): BountyPollingAlert[] {
  const alerts = pendingAlerts.get(userId) ?? [];
  pendingAlerts.delete(userId);
  return alerts;
}

export function stopAllBountyNotificationPolling(): void {
  for (const poller of activePollers.values()) {
    clearInterval(poller.timer);
  }
  activePollers.clear();
  pendingAlerts.clear();
}
