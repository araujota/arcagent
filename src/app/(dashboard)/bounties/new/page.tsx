"use client";

import { BountyWizard } from "@/components/bounties/bounty-form/bounty-wizard";

export default function NewBountyPage() {
  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Create a Bounty</h1>
        <p className="text-muted-foreground">
          Define your coding task, add test specifications, and set a reward.
        </p>
      </div>
      <BountyWizard />
    </div>
  );
}
