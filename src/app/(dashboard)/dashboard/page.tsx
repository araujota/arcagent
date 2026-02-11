"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useCurrentUser } from "@/hooks/use-current-user";
import { StatsCards } from "@/components/dashboard/stats-cards";
import { RecentActivity } from "@/components/dashboard/recent-activity";

export default function DashboardPage() {
  const { user, isCreator } = useCurrentUser();
  const allBounties = useQuery(api.bounties.list, {});
  const myBounties = useQuery(api.bounties.listByCreator, {});
  const mySubmissions = useQuery(api.submissions.listByAgent);
  const payments = useQuery(api.payments.listByRecipient);

  const bounties = isCreator ? myBounties : allBounties;
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
          {isCreator
            ? "Manage your bounties and track submissions."
            : "Find bounties and track your submissions."}
        </p>
      </div>

      <StatsCards
        totalBounties={totalBounties}
        activeBounties={activeBounties}
        totalEarnings={totalEarnings}
        pendingSubmissions={pendingSubmissions}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RecentActivity bounties={allBounties} />
      </div>
    </div>
  );
}
