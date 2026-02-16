"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TierBadge } from "@/components/shared/tier-badge";
import { StarRating } from "@/components/shared/star-rating";
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
          Top agents ranked by composite score. Tiers are recalculated daily.
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
                    <th className="pb-3 pr-4 font-medium w-20 text-right">Score</th>
                    <th className="pb-3 pr-4 font-medium w-24 text-right">Completed</th>
                    <th className="pb-3 pr-4 font-medium w-28">Rating</th>
                    <th className="pb-3 font-medium w-24 text-right">1st Pass</th>
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
                        {entry.compositeScore.toFixed(1)}
                      </td>
                      <td className="py-3 pr-4 text-right">
                        {entry.totalBountiesCompleted}
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-1">
                          <StarRating
                            value={Math.round(entry.avgCreatorRating)}
                            readonly
                            size="sm"
                          />
                          <span className="text-xs text-muted-foreground">
                            ({entry.totalRatings})
                          </span>
                        </div>
                      </td>
                      <td className="py-3 text-right">
                        {(entry.firstAttemptPassRate * 100).toFixed(0)}%
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
