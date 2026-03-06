import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { drainBountyNotificationAlerts } from "./bountyNotificationPolling";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";

interface ConvexNotification {
  _id: string;
  userId: string;
  type: string;
  bountyId: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: number;
}

export function registerCheckNotifications(server: McpServer): void {
  registerTool(
    server,
    "check_notifications",
    "Check for new bounty notifications. Returns unread notifications and automatically marks them as read.",
    {
      limit: z
        .string()
        .optional()
        .describe("Max notifications to return (default: 20)"),
    },
    async (args: { limit?: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:read");
      // SECURITY (C1): Resolve userId from auth context
      const authUser = getAuthUser();
      const userId = authUser?.userId;
      if (!userId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Authentication required. No user ID available.",
            },
          ],
          isError: true,
        };
      }

      const result = await callConvex<{
        notifications: ConvexNotification[];
      }>("/api/mcp/notifications/list", {
        userId,
        limit: args.limit ? parseInt(args.limit, 10) : undefined,
      });

      const notifications = result.notifications;
      const bountyWatchAlerts = drainBountyNotificationAlerts(userId);

      if (notifications.length === 0 && bountyWatchAlerts.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No new notifications.",
            },
          ],
        };
      }

      const lines = notifications.map(
        (n) =>
          `- **${n.title}** (bounty: ${n.bountyId})\n  ${n.message}\n  _${new Date(n.createdAt).toISOString()}_`,
      );
      const bountyWatchLines = bountyWatchAlerts.map(
        (alert) =>
          `- **${alert.title}** (bounty: ${alert.bountyId})\n  ${alert.message}\n  _${new Date(alert.createdAt).toISOString()}_`,
      );

      let markReadNote = "";
      if (notifications.length > 0) {
        const notificationIds = notifications.map((n) => n._id);
        markReadNote = "_(All platform notifications marked as read)_";
        try {
          await callConvex("/api/mcp/notifications/mark-read", {
            notificationIds,
          });
        } catch {
          markReadNote = "_(Warning: could not mark platform notifications as read. They may appear again.)_";
        }
      }

      const sections = [...lines, ...bountyWatchLines];
      return {
        content: [
          {
            type: "text" as const,
            text:
              `${sections.length} new notification(s):\n\n${sections.join("\n\n")}` +
              (markReadNote ? `\n\n${markReadNote}` : ""),
          },
        ],
      };
    },
  );
}
