import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));
vi.mock("./bountyNotificationPolling", () => ({
  drainBountyNotificationAlerts: vi.fn(),
}));

import { callConvex } from "../convex/client";
import { runWithAuth } from "../lib/context";
import type { AuthenticatedUser } from "../lib/types";
import { drainBountyNotificationAlerts } from "./bountyNotificationPolling";
import { registerCheckNotifications } from "./checkNotifications";

const mockCallConvex = vi.mocked(callConvex);
const mockDrainBountyNotificationAlerts = vi.mocked(drainBountyNotificationAlerts);

function createMockServer() {
  const tools: Record<string, { handler: Function }> = {};
  return {
    tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
      tools[name] = { handler };
    },
    tools,
  };
}

const testUser: AuthenticatedUser = {
  userId: "user_agent",
  name: "Agent",
  email: "agent@test.com",
  role: "agent",
  scopes: ["bounties:read"],
};

describe("check_notifications tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerCheckNotifications(server as any);
    handler = server.tools["check_notifications"].handler;
  });

  it("returns both platform notifications and bounty watch alerts", async () => {
    mockCallConvex
      .mockResolvedValueOnce({
        notifications: [
          {
            _id: "n1",
            userId: "user_agent",
            type: "new_bounty",
            bountyId: "b1",
            title: "General notification",
            message: "Platform message",
            read: false,
            createdAt: 1_700_000_000_000,
          },
        ],
      })
      .mockResolvedValueOnce({ success: true });
    mockDrainBountyNotificationAlerts.mockReturnValueOnce([
      {
        bountyId: "b2",
        title: "Threshold match: Fresh bounty",
        message: "Bounty \"Fresh bounty\" matches your watch threshold of 200 USD.",
        createdAt: 1_700_000_100_000,
      },
    ]);

    const result = await runWithAuth(testUser, () => handler({}));

    expect(result.content[0].text).toContain("2 new notification(s)");
    expect(result.content[0].text).toContain("General notification");
    expect(result.content[0].text).toContain("Threshold match: Fresh bounty");
    expect(mockCallConvex).toHaveBeenNthCalledWith(
      2,
      "/api/mcp/notifications/mark-read",
      { notificationIds: ["n1"] },
    );
  });

  it("returns bounty watch alerts without calling mark-read", async () => {
    mockCallConvex.mockResolvedValueOnce({ notifications: [] });
    mockDrainBountyNotificationAlerts.mockReturnValueOnce([
      {
        bountyId: "b2",
        title: "Threshold match: Fresh bounty",
        message: "Bounty \"Fresh bounty\" matches your watch threshold of 200 USD.",
        createdAt: 1_700_000_100_000,
      },
    ]);

    const result = await runWithAuth(testUser, () => handler({}));

    expect(result.content[0].text).toContain("1 new notification(s)");
    expect(result.content[0].text).toContain("Threshold match: Fresh bounty");
    expect(mockCallConvex).toHaveBeenCalledTimes(1);
  });
});
