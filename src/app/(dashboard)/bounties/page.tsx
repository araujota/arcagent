"use client";

import { Suspense } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { BountyCard } from "@/components/bounties/bounty-card";
import { BountyFilters } from "@/components/bounties/bounty-filters";
import { EmptyState } from "@/components/shared/empty-state";
import { CardGridSkeleton } from "@/components/shared/loading-skeleton";
import { useBountyFilters } from "@/hooks/use-bounty-filters";
import { Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

function BountyExplorerContent() {
  const { status, paymentMethod, search } = useBountyFilters();

  const bounties = useQuery(api.bounties.list, {
    status: status as
      | "draft"
      | "active"
      | "in_progress"
      | "completed"
      | "disputed"
      | undefined,
    paymentMethod: paymentMethod as "stripe" | "web3" | undefined,
    search,
  });

  if (bounties === undefined) {
    return <CardGridSkeleton />;
  }

  if (bounties.length === 0) {
    return (
      <EmptyState
        icon={Trophy}
        title="No bounties found"
        description="No bounties match your current filters. Try adjusting your search or create a new bounty."
        actionLabel="Create Bounty"
        actionHref="/bounties/new"
      />
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {bounties.map((bounty) => (
        <BountyCard key={bounty._id} bounty={bounty} />
      ))}
    </div>
  );
}

export default function BountiesPage() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Bounties</h1>
          <p className="text-muted-foreground">
            Browse and discover coding bounties.
          </p>
        </div>
        <Button asChild>
          <Link href="/bounties/new">Create Bounty</Link>
        </Button>
      </div>

      <Suspense fallback={<CardGridSkeleton />}>
        <BountyFilters />
        <BountyExplorerContent />
      </Suspense>
    </div>
  );
}
