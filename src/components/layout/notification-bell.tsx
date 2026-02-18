"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Bell } from "lucide-react";
import Link from "next/link";

export function NotificationBell() {
  const notifications = useQuery(api.notifications.listMyUnread) ?? [];
  const markAsRead = useMutation(api.notifications.markAsRead);

  const handleMarkAllRead = async () => {
    if (notifications.length === 0) return;
    await markAsRead({
      notificationIds: notifications.map((n) => n._id),
    });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative text-muted-foreground hover:text-foreground transition-colors">
          <Bell className="h-4 w-4" />
          {notifications.length > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-primary text-[10px] font-medium text-primary-foreground flex items-center justify-center glow-blue">
              {notifications.length > 9 ? "9+" : notifications.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 border-white/[0.08] shadow-2xl">
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-display text-sm font-semibold">Notifications</h4>
          {notifications.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-auto py-1 text-muted-foreground hover:text-foreground"
              onClick={handleMarkAllRead}
            >
              Mark all read
            </Button>
          )}
        </div>
        {notifications.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No new notifications
          </p>
        ) : (
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {notifications.map((n) => (
              <Link
                key={n._id}
                href={n.bountyId ? `/bounties/${n.bountyId}` : "#"}
                className="block rounded-md p-2 hover:bg-white/[0.04] transition-colors"
              >
                <p className="font-display font-medium text-xs">{n.title}</p>
                <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                  {n.message}
                </p>
              </Link>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
