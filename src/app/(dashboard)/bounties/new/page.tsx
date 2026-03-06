"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { BountyWizard } from "@/components/bounties/bounty-form/bounty-wizard";
import { Skeleton } from "@/components/ui/skeleton";

function NewBountyContent() {
  const searchParams = useSearchParams();
  const repoUrl = searchParams.get("repoUrl") ?? undefined;

  return <BountyWizard repoUrl={repoUrl} />;
}

export default function NewBountyPage() {
  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Create a Bounty</h1>
        <p className="text-muted-foreground">
          Describe the work, define how success should be checked, and set the reward and access rules.
        </p>
      </div>
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <NewBountyContent />
      </Suspense>
    </div>
  );
}
