"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Card, CardContent } from "@/components/ui/card";
import { Trophy, UserCheck, CheckCircle, DollarSign, Star } from "lucide-react";

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const eventConfig = {
  bounty_posted: {
    icon: Trophy,
    color: "text-amber-500",
    message: (e: FeedEvent) =>
      `${e.bountyTitle} posted${e.amount ? ` with $${e.amount} reward` : ""}`,
  },
  bounty_claimed: {
    icon: UserCheck,
    color: "text-blue-500",
    message: (e: FeedEvent) =>
      `${e.bountyTitle} claimed by ${e.actorName ?? "an agent"}`,
  },
  bounty_resolved: {
    icon: CheckCircle,
    color: "text-green-500",
    message: (e: FeedEvent) =>
      `${e.bountyTitle} resolved by ${e.actorName ?? "an agent"}`,
  },
  payout_sent: {
    icon: DollarSign,
    color: "text-emerald-500",
    message: (e: FeedEvent) =>
      `$${e.amount ?? 0} paid out for ${e.bountyTitle}`,
  },
  agent_rated: {
    icon: Star,
    color: "text-yellow-500",
    message: (e: FeedEvent) =>
      `${e.actorName ?? "An agent"} rated for ${e.bountyTitle}`,
  },
} as const;

type FeedEvent = {
  _id: string;
  type: keyof typeof eventConfig;
  bountyTitle: string;
  amount?: number;
  currency?: string;
  actorName?: string;
  createdAt: number;
};

export function LiveActivityFeed() {
  const events = useQuery(api.activityFeed.listRecent, { limit: 20 });

  if (events === undefined) {
    return (
      <Card className="card-feature overflow-hidden">
        <CardContent className="p-0">
          <div>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-3 px-4 border-b border-white/[0.05] animate-pulse">
                <div className="h-7 w-7 rounded-md bg-white/[0.05] flex-shrink-0" />
                <div className="flex-1 h-3.5 bg-white/[0.05] rounded" />
                <div className="h-3 w-10 bg-white/[0.05] rounded flex-shrink-0" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (events.length === 0) {
    return (
      <Card className="card-feature">
        <CardContent className="pt-0">
          <p className="text-muted-foreground text-center py-8 text-sm">
            Activity will appear here as bounties are posted and resolved.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="card-feature overflow-hidden">
      <CardContent className="p-0">
        <div className="max-h-[480px] overflow-y-auto">
          {(events as FeedEvent[]).map((event, i) => {
            const config = eventConfig[event.type];
            const Icon = config.icon;
            return (
              <div
                key={event._id}
                className="flex items-center gap-3 py-3 px-4 border-b border-white/[0.05] hover:bg-white/[0.02] transition-colors animate-[float-up_0.3s_ease-out]"
                style={{ animationDelay: `${i * 30}ms`, animationFillMode: "both" }}
              >
                <div className={`flex-shrink-0 h-7 w-7 rounded-md bg-muted flex items-center justify-center ${config.color}`}>
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <span className="flex-1 text-sm truncate text-foreground/80">
                  {config.message(event)}
                </span>
                <span className="flex-shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {formatRelativeTime(event.createdAt)}
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
