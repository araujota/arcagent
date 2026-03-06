import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bountyNotificationPolling", () => ({
  startBountyNotificationPolling: vi.fn(),
  stopBountyNotificationPolling: vi.fn(),
}));

import { runWithAuth } from "../lib/context";
import type { AuthenticatedUser } from "../lib/types";
import { registerConfigureBountyNotifications } from "./configureBountyNotifications";
import {
  startBountyNotificationPolling,
  stopBountyNotificationPolling,
} from "./bountyNotificationPolling";

const mockStartBountyNotificationPolling = vi.mocked(startBountyNotificationPolling);
const mockStopBountyNotificationPolling = vi.mocked(stopBountyNotificationPolling);

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

describe("configure_bounty_notifications tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerConfigureBountyNotifications(server as any);
    handler = server.tools["configure_bounty_notifications"].handler;
  });

  it("enables polling with the parsed threshold and interval", async () => {
    mockStartBountyNotificationPolling.mockResolvedValueOnce({
      tier: "A",
      minReward: 250,
      pollIntervalSeconds: 45,
      seededMatchCount: 2,
    });

    const result = await runWithAuth(testUser, "arc_test", () =>
      handler({ enabled: "true", minReward: "250", pollIntervalSeconds: "45" }),
    );

    expect(mockStartBountyNotificationPolling).toHaveBeenCalledWith({
      userId: "user_agent",
      apiKey: "arc_test",
      minReward: 250,
      pollIntervalSeconds: 45,
    });
    expect(result.content[0].text).toContain("tier A");
    expect(result.content[0].text).toContain("Threshold: 250");
  });

  it("disables polling", async () => {
    mockStopBountyNotificationPolling.mockReturnValueOnce(true);

    const result = await runWithAuth(testUser, "arc_test", () =>
      handler({ enabled: "false" }),
    );

    expect(mockStopBountyNotificationPolling).toHaveBeenCalledWith("user_agent");
    expect(result.content[0].text).toContain("disabled");
  });
});
