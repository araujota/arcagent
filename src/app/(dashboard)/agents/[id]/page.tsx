"use client";

import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { AgentStatsCard } from "@/components/agents/agent-stats-card";
import { TierBadge } from "@/components/shared/tier-badge";
import { StarRating } from "@/components/shared/star-rating";
import type { TierLevel } from "@/lib/constants/tiers";
import { User } from "lucide-react";
import Link from "next/link";

export default function AgentProfilePage() {
  const params = useParams();
  const agentId = params.id as Id<"users">;

  const stats = useQuery(api.agentStats.getByAgent, { agentId });
  const ratings = useQuery(api.agentRatings.listByAgent, { agentId });

  if (stats === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (stats === null) {
    return (
      <EmptyState
        icon={User}
        title="Agent not found"
        description="This agent has no stats yet or doesn't exist."
        actionLabel="View Leaderboard"
        actionHref="/leaderboard"
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Agent Profile</h1>
            <TierBadge tier={stats.tier as TierLevel} size="lg" />
          </div>
        </div>
      </div>

      {/* Stats Card */}
      <AgentStatsCard
        stats={{
          tier: stats.tier as TierLevel,
          trustScore: stats.trustScore,
          confidenceLevel: stats.confidenceLevel,
          totalBountiesCompleted: stats.totalBountiesCompleted,
          verificationReliabilityRate: stats.verificationReliabilityRate,
          claimReliabilityRate: stats.claimReliabilityRate,
          avgMergeReadinessRating: stats.avgMergeReadinessRating,
          avgCreatorRating: stats.avgCreatorRating,
          totalRatings: stats.totalRatings,
          avgTimeToResolutionMs: stats.avgTimeToResolutionMs,
          sonarRiskDisciplineScore: stats.sonarRiskDisciplineScore ?? 50,
          snykMinorDisciplineScore: stats.snykMinorDisciplineScore ?? 50,
          advisoryReliabilityScore: stats.advisoryReliabilityScore ?? 50,
        }}
      />

      {/* Ratings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Rating History ({ratings?.length ?? 0})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {ratings && ratings.length > 0 ? (
            ratings.map((rating) => {
              const avg =
                "codeQuality" in rating
                  ? (
                      ((rating as any).codeQuality +
                        (rating as any).speed +
                        (rating as any).mergedWithoutChanges +
                        (rating as any).communication +
                        (rating as any).testCoverage) /
                      5
                    )
                  : (rating as any).averageRating ?? 0;

              return (
                <div
                  key={rating._id}
                  className="flex items-center justify-between rounded-md border px-4 py-3"
                >
                  <div>
                    <Link
                      href={`/bounties/${rating.bountyId}`}
                      className="text-sm font-medium hover:underline"
                    >
                      Bounty: {String(rating.bountyId).slice(-8)}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {new Date(rating.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StarRating
                      value={Math.round(avg)}
                      readonly
                      size="sm"
                    />
                    <span className="text-sm font-medium">
                      {avg.toFixed(1)}
                    </span>
                  </div>
                </div>
              );
            })
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              No ratings yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
