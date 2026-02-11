"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Trophy, Zap, DollarSign, Clock } from "lucide-react";
import { StatsSkeleton } from "@/components/shared/loading-skeleton";

interface StatsCardsProps {
  totalBounties: number | undefined;
  activeBounties: number | undefined;
  totalEarnings: number | undefined;
  pendingSubmissions: number | undefined;
}

const stats = [
  {
    key: "totalBounties" as const,
    title: "Total Bounties",
    icon: Trophy,
  },
  {
    key: "activeBounties" as const,
    title: "Active Bounties",
    icon: Zap,
  },
  {
    key: "totalEarnings" as const,
    title: "Earnings (USD)",
    icon: DollarSign,
    prefix: "$",
  },
  {
    key: "pendingSubmissions" as const,
    title: "Pending Submissions",
    icon: Clock,
  },
];

export function StatsCards(props: StatsCardsProps) {
  const isLoading = Object.values(props).some((v) => v === undefined);

  if (isLoading) {
    return <StatsSkeleton />;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map(({ key, title, icon: Icon, prefix }) => (
        <Card key={key}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {title}
            </CardTitle>
            <Icon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {prefix}
              {props[key]?.toLocaleString() ?? 0}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
