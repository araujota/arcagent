"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BountyStatusBadge } from "@/components/bounties/bounty-status-badge";
import { BountyWithCreator } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";

interface RecentActivityProps {
  bounties: BountyWithCreator[] | undefined;
}

export function RecentActivity({ bounties }: RecentActivityProps) {
  if (bounties === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between">
              <div className="space-y-1">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  const recent = bounties.slice(0, 10);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent Activity</CardTitle>
      </CardHeader>
      <CardContent>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent activity</p>
        ) : (
          <div className="space-y-4">
            {recent.map((bounty) => (
              <Link
                key={bounty._id}
                href={`/bounties/${bounty._id}`}
                className="flex items-center justify-between hover:bg-muted/50 -mx-2 px-2 py-1.5 rounded-md transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {bounty.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {bounty.reward} {bounty.rewardCurrency}
                    {bounty.creator && ` by ${bounty.creator.name}`}
                  </p>
                </div>
                <BountyStatusBadge status={bounty.status} />
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
