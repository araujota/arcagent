import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
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

      if (notifications.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No new notifications.",
            },
          ],
        };
      }

      // Format as readable text
      const lines = notifications.map(
        (n) =>
          `- **${n.title}** (bounty: ${n.bountyId})\n  ${n.message}\n  _${new Date(n.createdAt).toISOString()}_`,
      );

      // Auto-mark as read
      const notificationIds = notifications.map((n) => n._id);
      await callConvex("/api/mcp/notifications/mark-read", {
        notificationIds,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `${notifications.length} new notification(s):\n\n${lines.join("\n\n")}\n\n_(All marked as read)_`,
          },
        ],
      };
    },
  );
}
