"use client";

import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../../../../../convex/_generated/api";
import { Id } from "../../../../../../../../convex/_generated/dataModel";
import { VerificationProgress } from "@/components/verification/verification-progress";
import { SanityGateCard } from "@/components/verification/sanity-gate-card";
import { TestResultsTree } from "@/components/verification/test-results-tree";
import { EmptyState } from "@/components/shared/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Shield, FileText } from "lucide-react";
import Link from "next/link";

export default function VerificationPage() {
  const params = useParams();
  const submissionId = params.subId as Id<"submissions">;
  const bountyId = params.id as Id<"bounties">;

  const verification = useQuery(api.verifications.getBySubmission, {
    submissionId,
  });

  const verificationId = verification?._id;

  const sanityGates = useQuery(
    api.sanityGates.listByVerification,
    verificationId ? { verificationId } : "skip"
  );

  const steps = useQuery(
    api.verificationSteps.listByVerification,
    verificationId ? { verificationId } : "skip"
  );

  if (verification === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (verification === null) {
    return (
      <EmptyState
        icon={Shield}
        title="No verification found"
        description="This submission hasn't been verified yet."
        actionLabel="Back to Submission"
        actionHref={`/bounties/${bountyId}/submissions/${submissionId}`}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Verification Results</h1>
        <p className="text-sm text-muted-foreground">
          <Link
            href={`/bounties/${bountyId}/submissions/${submissionId}`}
            className="underline hover:text-foreground"
          >
            Back to submission
          </Link>
        </p>
      </div>

      {/* Overall Progress */}
      <Card>
        <CardContent className="pt-6">
          <VerificationProgress
            steps={steps ?? []}
            status={verification.status}
          />
        </CardContent>
      </Card>

      {verification.errorLog && (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-base text-destructive">
              Error Log
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-sm font-mono bg-muted rounded p-3 overflow-x-auto">
              {verification.errorLog}
            </pre>
          </CardContent>
        </Card>
      )}

      <Separator />

      {/* Sanity Gates */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Sanity Gates</h2>
        {sanityGates && sanityGates.length > 0 ? (
          <div className="space-y-2">
            {sanityGates.map((gate) => (
              <SanityGateCard key={gate._id} gate={gate} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No sanity gate results available.
          </p>
        )}
      </div>

      <Separator />

      {/* Test Results */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Test Results</h2>
        <TestResultsTree steps={steps ?? []} />
      </div>
    </div>
  );
}
