import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  startBountyNotificationPolling,
  stopBountyNotificationPolling,
} from "./bountyNotificationPolling";
import {
  requireAuthApiKey,
  requireAuthUser,
  requireScope,
} from "../lib/context";
import { registerTool } from "../lib/toolHelper";

function parseEnabledFlag(value?: string): boolean {
  if (!value) {
    throw new Error("Missing enabled flag. Use 'true' to enable or 'false' to disable.");
  }
  if (value.toLowerCase() === "true") {
    return true;
  }
  if (value.toLowerCase() === "false") {
    return false;
  }
  throw new Error("Invalid enabled flag. Use 'true' to enable or 'false' to disable.");
}

export function registerConfigureBountyNotifications(server: McpServer): void {
  registerTool(
    server,
    "configure_bounty_notifications",
    "Enable or disable background bounty polling alerts for tiered agents. " +
      "When enabled, threshold matches are surfaced through check_notifications.",
    {
      enabled: z.string().describe("Set to 'true' to enable alerts or 'false' to disable them"),
      minReward: z.string().optional().describe("Minimum reward amount that should trigger an alert"),
      pollIntervalSeconds: z.string().optional().describe("Polling interval in seconds (default 60, min 15, max 300)"),
    },
    async (args: { enabled: string; minReward?: string; pollIntervalSeconds?: string }) => {
      requireScope("bounties:read");

      const enabled = parseEnabledFlag(args.enabled);
      const user = requireAuthUser();

      if (!enabled) {
        const wasActive = stopBountyNotificationPolling(user.userId);
        return {
          content: [
            {
              type: "text" as const,
              text: wasActive
                ? "Bounty polling alerts disabled."
                : "Bounty polling alerts were already disabled.",
            },
          ],
        };
      }

      const apiKey = requireAuthApiKey();
      const minReward = Number(args.minReward);
      if (!Number.isFinite(minReward) || minReward <= 0) {
        throw new Error("minReward must be a positive number when enabling bounty polling alerts.");
      }

      const pollIntervalSeconds = args.pollIntervalSeconds
        ? Number(args.pollIntervalSeconds)
        : undefined;
      const result = await startBountyNotificationPolling({
        userId: user.userId,
        apiKey,
        minReward,
        pollIntervalSeconds,
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Bounty polling alerts enabled for tier ${result.tier}. ` +
              `Threshold: ${result.minReward}. ` +
              `Polling every ${result.pollIntervalSeconds} seconds. ` +
              `Current matching bounties tracked without alerting: ${result.seededMatchCount}. ` +
              `Use check_notifications to collect threshold matches as they arrive.`,
          },
        ],
      };
    },
  );
}
