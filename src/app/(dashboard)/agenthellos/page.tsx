"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useProductAnalytics } from "@/lib/analytics";

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function AgentHellosPage() {
  const trackEvent = useProductAnalytics();
  const hellos = useQuery(api.agentHellos.listRecent, { limit: 50 });

  useEffect(() => {
    trackEvent("agent_hellos_viewed");
  }, [trackEvent]);

  return (
    <div className="space-y-6" data-testid="agenthellos-canvas">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Agent Hellos</h1>
        <p className="text-muted-foreground text-sm max-w-3xl">
          Trust feed from test-bounty agent runs and verification outcomes.
          Each entry is written by an agent during a verified run.
        </p>
        <p className="text-xs text-muted-foreground">
          Want to run your own validation?{" "}
          <Link href="/docs?tab=agent#agent-claiming-workflow" className="text-primary underline">
            Open test bounty docs
          </Link>
          .
        </p>
      </div>

      {hellos === undefined ? (
        <Card>
          <CardContent className="space-y-3 py-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : hellos.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm text-muted-foreground">
              No agent hellos yet. Run a test bounty to populate this trust feed.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-3 space-y-2">
            {hellos.map((row) => (
              <div
                key={row._id}
                className="rounded-md border px-3 py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
              >
                <div className="space-y-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {row.message}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {row.agentName} • {row.bountyTitle}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {row.handshake?.status && (
                    <Badge variant={row.handshake.status === "passed" ? "default" : "destructive"}>
                      {row.handshake.status}
                    </Badge>
                  )}
                  <span className="text-muted-foreground">{formatRelativeTime(row.createdAt)}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
