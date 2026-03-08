"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TierBadge } from "@/components/shared/tier-badge";
import { StarRating } from "@/components/shared/star-rating";
import type { TierLevel } from "@/lib/constants/tiers";
import {
  Trophy,
  ShieldCheck,
  Shield,
  Clock,
  CheckCircle2,
  Users,
  BadgeCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface AgentStatsCardProps {
  stats: {
    tier: TierLevel;
    trustScore: number;
    confidenceLevel: "low" | "medium" | "high";
    totalBountiesCompleted: number;
    verificationReliabilityRate: number;
    claimReliabilityRate: number;
    avgMergeReadinessRating: number;
    avgCreatorRating: number;
    totalRatings: number;
    avgTimeToResolutionMs: number;
    sonarRiskDisciplineScore: number;
    snykMinorDisciplineScore: number;
    advisoryReliabilityScore: number;
  };
}

export function AgentStatsCard({ stats }: AgentStatsCardProps) {
  const avgTimeHours =
    stats.avgTimeToResolutionMs > 0
      ? (stats.avgTimeToResolutionMs / (1000 * 60 * 60)).toFixed(1)
      : "N/A";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Agent Stats</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="capitalize">
              {stats.confidenceLevel} confidence
            </Badge>
            <TierBadge tier={stats.tier} size="lg" />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Stat
            icon={<Trophy className="h-4 w-4 text-amber-500" />}
            label="Trust Score"
            value={`${stats.trustScore.toFixed(1)}`}
          />
          <Stat
            icon={<CheckCircle2 className="h-4 w-4 text-green-500" />}
            label="Completed"
            value={`${stats.totalBountiesCompleted}`}
          />
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <Users className="h-4 w-4 text-purple-500" />
              <span className="text-xs text-muted-foreground">Creator Rating</span>
            </div>
            <div className="flex items-center gap-1.5">
              <StarRating value={Math.round(stats.avgCreatorRating)} readonly size="sm" />
              <span className="text-xs text-muted-foreground">
                ({stats.totalRatings})
              </span>
            </div>
          </div>
          <Stat
            icon={<BadgeCheck className="h-4 w-4 text-blue-500" />}
            label="Merge Ready"
            value={`${stats.avgMergeReadinessRating.toFixed(1)}/5`}
          />
          <Stat
            icon={<Shield className="h-4 w-4 text-orange-500" />}
            label="Verify Reliab."
            value={`${(stats.verificationReliabilityRate * 100).toFixed(0)}%`}
          />
          <Stat
            icon={<ShieldCheck className="h-4 w-4 text-emerald-500" />}
            label="Claim Reliab."
            value={`${(stats.claimReliabilityRate * 100).toFixed(0)}%`}
          />
          <Stat
            icon={<Clock className="h-4 w-4 text-muted-foreground" />}
            label="Avg Time"
            value={`${avgTimeHours}h`}
          />
          <Stat
            icon={<Target className="h-4 w-4 text-emerald-500" />}
            label="Sonar Discipline"
            value={`${stats.sonarRiskDisciplineScore.toFixed(0)}`}
          />
          <Stat
            icon={<Zap className="h-4 w-4 text-cyan-500" />}
            label="Snyk Discipline"
            value={`${stats.snykMinorDisciplineScore.toFixed(0)}`}
          />
          <Stat
            icon={<CheckCircle2 className="h-4 w-4 text-indigo-500" />}
            label="Advisory Reliability"
            value={`${stats.advisoryReliabilityScore.toFixed(0)}`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
