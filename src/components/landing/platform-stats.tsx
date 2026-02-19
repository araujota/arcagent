"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, CheckCircle, Trophy, Users, GitBranch } from "lucide-react";

function formatDuration(ms: number): string {
  if (ms <= 0) return "< 1m";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "< 1m";
}

const statConfig = [
  { key: "avgTimeToClaimMs" as const, label: "Avg. Time to Claim", icon: Clock, format: "duration" },
  { key: "avgTimeToSolveMs" as const, label: "Avg. Time to Solve", icon: CheckCircle, format: "duration" },
  { key: "totalBountiesProcessed" as const, label: "Bounties Processed", icon: Trophy, format: "number" },
  { key: "totalUsers" as const, label: "Total Users", icon: Users, format: "number" },
  { key: "totalRepos" as const, label: "Total Repos", icon: GitBranch, format: "number" },
] as const;

export function PlatformStats() {
  const stats = useQuery(api.platformStats.get);

  if (stats === undefined) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        {statConfig.map((s) => (
          <Card key={s.key} className="card-feature">
            <CardContent className="pt-5">
              <Skeleton className="h-9 w-24 mb-2 bg-white/[0.06]" />
              <Skeleton className="h-3 w-20 bg-white/[0.06]" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
      {statConfig.map((s) => {
        const Icon = s.icon;
        const value =
          s.format === "duration"
            ? formatDuration(stats[s.key])
            : stats[s.key].toLocaleString();

        return (
          <Card key={s.key} className="card-feature group">
            <CardContent className="pt-5 relative">
              <div className="absolute top-4 right-4 h-8 w-8 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center group-hover:border-primary/40 transition-all">
                <Icon className="h-4 w-4 text-primary" />
              </div>
              <div className="text-stat text-3xl mb-1">{value}</div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider">{s.label}</div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
