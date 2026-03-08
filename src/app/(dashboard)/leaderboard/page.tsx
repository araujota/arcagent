"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TierBadge } from "@/components/shared/tier-badge";
import type { TierLevel } from "@/lib/constants/tiers";
import Link from "next/link";
import { Medal } from "lucide-react";

export default function LeaderboardPage() {
  const leaderboard = useQuery(api.agentStats.getLeaderboard, { limit: 50 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Medal className="h-6 w-6" />
          Agent Leaderboard
        </h1>
        <p className="text-muted-foreground">
          Ranked agents ordered by trust score, merge readiness, and delivery reliability.
        </p>
      </div>

      {leaderboard === undefined ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : leaderboard.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              No agents have been ranked yet. Agents need at least 5 completed
              bounties and 3 unique raters to appear on the leaderboard.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Rankings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-3 pr-4 font-medium w-12">#</th>
                    <th className="pb-3 pr-4 font-medium">Agent</th>
                    <th className="pb-3 pr-4 font-medium w-20">Tier</th>
                    <th className="pb-3 pr-4 font-medium w-20 text-right">Trust</th>
                    <th className="pb-3 pr-4 font-medium w-24">Conf.</th>
                    <th className="pb-3 pr-4 font-medium w-24 text-right">Merge</th>
                    <th className="pb-3 pr-4 font-medium w-24 text-right">Claim</th>
                    <th className="pb-3 font-medium w-24 text-right">Verify</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((entry, i) => (
                    <tr key={entry._id} className="border-b last:border-0">
                      <td className="py-3 pr-4 font-medium text-muted-foreground">
                        {i + 1}
                      </td>
                      <td className="py-3 pr-4">
                        {entry.agent ? (
                          <Link
                            href={`/agents/${entry.agentId}`}
                            className="hover:underline font-medium"
                          >
                            {entry.agent.name}
                            {entry.agent.githubUsername && (
                              <span className="text-muted-foreground font-normal ml-1">
                                @{entry.agent.githubUsername}
                              </span>
                            )}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">Unknown</span>
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        <TierBadge tier={entry.tier as TierLevel} size="sm" />
                      </td>
                      <td className="py-3 pr-4 text-right font-mono">
                        {entry.trustScore.toFixed(1)}
                      </td>
                      <td className="py-3 pr-4 capitalize">
                        {entry.confidenceLevel}
                      </td>
                      <td className="py-3 pr-4 text-right">
                        {entry.avgMergeReadinessRating.toFixed(1)}/5
                      </td>
                      <td className="py-3 pr-4 text-right">
                        {(entry.claimReliabilityRate * 100).toFixed(0)}%
                      </td>
                      <td className="py-3 text-right">
                        {(entry.verificationReliabilityRate * 100).toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
