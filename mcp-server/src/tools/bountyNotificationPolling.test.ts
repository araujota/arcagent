import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));

import { callConvex } from "../convex/client";
import {
  drainBountyNotificationAlerts,
  hasBountyNotificationPolling,
  pollBountyNotificationWatch,
  startBountyNotificationPolling,
  stopAllBountyNotificationPolling,
  stopBountyNotificationPolling,
} from "./bountyNotificationPolling";

const mockCallConvex = vi.mocked(callConvex);

describe("bounty notification polling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopAllBountyNotificationPolling();
  });

  afterEach(() => {
    stopAllBountyNotificationPolling();
  });

  it("only enables polling for tiered agents", async () => {
    mockCallConvex.mockResolvedValueOnce({
      stats: { tier: "unranked" },
    });

    await expect(
      startBountyNotificationPolling({
        userId: "agent_1",
        apiKey: "arc_test",
        minReward: 150,
      }),
    ).rejects.toThrow("tiered agents");

    expect(hasBountyNotificationPolling("agent_1")).toBe(false);
  });

  it("tracks current matches as baseline and only alerts on newly matching bounties", async () => {
    mockCallConvex
      .mockResolvedValueOnce({ stats: { tier: "A" } })
      .mockResolvedValueOnce({
        bounties: [
          { _id: "b_existing", title: "Existing", reward: 180, rewardCurrency: "USD" },
        ],
      });

    const startResult = await startBountyNotificationPolling({
      userId: "agent_1",
      apiKey: "arc_test",
      minReward: 175,
      pollIntervalSeconds: 30,
    });

    expect(startResult.seededMatchCount).toBe(1);
    expect(drainBountyNotificationAlerts("agent_1")).toEqual([]);

    mockCallConvex
      .mockResolvedValueOnce({ stats: { tier: "A" } })
      .mockResolvedValueOnce({
        bounties: [
          { _id: "b_existing", title: "Existing", reward: 180, rewardCurrency: "USD" },
          {
            _id: "b_fresh",
            title: "Fresh bounty",
            reward: 240,
            rewardCurrency: "USD",
            requiredTier: "B",
          },
        ],
      });

    await pollBountyNotificationWatch("agent_1");

    const alerts = drainBountyNotificationAlerts("agent_1");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].bountyId).toBe("b_fresh");
    expect(alerts[0].title).toContain("Fresh bounty");
    expect(alerts[0].message).toContain("175 USD");
    expect(alerts[0].message).toContain("240 USD");
    expect(alerts[0].message).toContain("Required tier: B+");

    mockCallConvex
      .mockResolvedValueOnce({ stats: { tier: "A" } })
      .mockResolvedValueOnce({
        bounties: [
          { _id: "b_existing", title: "Existing", reward: 180, rewardCurrency: "USD" },
          {
            _id: "b_fresh",
            title: "Fresh bounty",
            reward: 240,
            rewardCurrency: "USD",
            requiredTier: "B",
          },
        ],
      });

    await pollBountyNotificationWatch("agent_1");
    expect(drainBountyNotificationAlerts("agent_1")).toEqual([]);
  });

  it("disables an active poller and stops producing alerts", async () => {
    mockCallConvex
      .mockResolvedValueOnce({ stats: { tier: "S" } })
      .mockResolvedValueOnce({ bounties: [] });

    await startBountyNotificationPolling({
      userId: "agent_1",
      apiKey: "arc_test",
      minReward: 300,
    });

    expect(stopBountyNotificationPolling("agent_1")).toBe(true);
    expect(hasBountyNotificationPolling("agent_1")).toBe(false);

    await pollBountyNotificationWatch("agent_1");
    expect(drainBountyNotificationAlerts("agent_1")).toEqual([]);
  });

  it("stops polling if the agent is no longer tiered", async () => {
    mockCallConvex
      .mockResolvedValueOnce({ stats: { tier: "B" } })
      .mockResolvedValueOnce({ bounties: [] });

    await startBountyNotificationPolling({
      userId: "agent_1",
      apiKey: "arc_test",
      minReward: 200,
    });

    mockCallConvex.mockResolvedValueOnce({ stats: { tier: "unranked" } });

    await pollBountyNotificationWatch("agent_1");

    expect(hasBountyNotificationPolling("agent_1")).toBe(false);
  });
});
