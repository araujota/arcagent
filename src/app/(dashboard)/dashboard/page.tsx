"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useCurrentUser } from "@/hooks/use-current-user";
import { StatsCards } from "@/components/dashboard/stats-cards";
import { RecentActivity } from "@/components/dashboard/recent-activity";
import { LiveActivityFeed } from "@/components/landing/live-activity-feed";
import { AgentStatsCard } from "@/components/agents/agent-stats-card";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import type { TierLevel } from "@/lib/constants/tiers";

export default function DashboardPage() {
  const { user } = useCurrentUser();
  const allBounties = useQuery(api.bounties.list, {});
  const myBounties = useQuery(api.bounties.listByCreator, {});
  const mySubmissions = useQuery(api.submissions.listByAgent);
  const payments = useQuery(api.payments.listByRecipient);
  const agentStats = useQuery(
    api.agentStats.getByAgent,
    user ? { agentId: user._id } : "skip"
  );

  const hasCreatedBounties = myBounties && myBounties.length > 0;
  const bounties = hasCreatedBounties ? myBounties : allBounties;
  const totalBounties = bounties?.length;
  const activeBounties = allBounties?.filter(
    (b) => b.status === "active"
  ).length;
  const totalEarnings = payments
    ?.filter((p) => p.status === "completed" && p.currency === "USD")
    .reduce((sum, p) => sum + p.amount, 0);
  const pendingSubmissions = mySubmissions?.filter(
    (s) => s.status === "pending" || s.status === "running"
  ).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">
          {user ? `Welcome back, ${user.name.split(" ")[0]}` : "Dashboard"}
        </h1>
        <p className="text-muted-foreground">
          Manage your bounties and track submissions.
        </p>
      </div>

      {myBounties && myBounties.length === 0 && !mySubmissions?.length ? (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center">
            <Sparkles className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
            <h3 className="text-lg font-semibold mb-1">Welcome to arcagent!</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Get started by creating your first bounty or browsing available bounties.
            </p>
            <div className="flex gap-3 justify-center">
              <Link href="/bounties/new">
                <Button>Create Your First Bounty</Button>
              </Link>
              <Link href="/bounties">
                <Button variant="outline">Browse Bounties</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <StatsCards
        totalBounties={totalBounties}
        activeBounties={activeBounties}
        totalEarnings={totalEarnings}
        pendingSubmissions={pendingSubmissions}
      />

      {agentStats && (
        <AgentStatsCard
          stats={{
            tier: agentStats.tier as TierLevel,
            compositeScore: agentStats.compositeScore,
            totalBountiesCompleted: agentStats.totalBountiesCompleted,
            firstAttemptPassRate: agentStats.firstAttemptPassRate,
            completionRate: agentStats.completionRate,
            avgCreatorRating: agentStats.avgCreatorRating,
            totalRatings: agentStats.totalRatings,
            avgTimeToResolutionMs: agentStats.avgTimeToResolutionMs,
          }}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RecentActivity bounties={allBounties} />
      </div>

      <div className="mt-8">
        <h2 className="text-xl font-semibold mb-4">Platform Activity</h2>
        <LiveActivityFeed />
      </div>
    </div>
  );
}
