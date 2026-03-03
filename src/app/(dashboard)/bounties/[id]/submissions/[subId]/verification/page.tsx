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
import { Shield } from "lucide-react";
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
  const receipts = useQuery(
    api.verificationReceipts.listByVerification,
    verificationId ? { verificationId } : "skip"
  );
  const normalizedScannerReceipts = (receipts ?? [])
    .map((receipt) => ({
      ...receipt,
      normalized: parseNormalized(receipt.normalizedJson),
    }))
    .filter(
      (receipt) =>
        receipt.normalized &&
        (receipt.normalized.tool === "snyk" || receipt.normalized.tool === "sonarqube")
    )
    .sort((a, b) => a.orderIndex - b.orderIndex);

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

      {/* Normalized Blocking Receipts */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Blocking Reasons</h2>
        {normalizedScannerReceipts.length > 0 ? (
          <div className="space-y-3">
            {normalizedScannerReceipts.map((receipt) => (
              <Card key={receipt._id}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">
                    [{receipt.orderIndex}] {receipt.legKey}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p>
                    <span className="text-muted-foreground">Blocking:</span>{" "}
                    {receipt.normalized!.blocking.isBlocking ? "yes" : "no"}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Reason:</span>{" "}
                    {receipt.normalized!.blocking.reasonCode} - {receipt.normalized!.blocking.reasonText}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Introduced:</span>{" "}
                    {receipt.normalized!.counts.introducedTotal} (critical={receipt.normalized!.counts.critical}, high={receipt.normalized!.counts.high}, medium={receipt.normalized!.counts.medium}, low={receipt.normalized!.counts.low})
                  </p>
                  {receipt.normalized!.tool === "sonarqube" && (
                    <p>
                      <span className="text-muted-foreground">Sonar Metrics:</span>{" "}
                      bugs={receipt.normalized!.counts.bugs}, code smells={receipt.normalized!.counts.codeSmells}, complexity delta={receipt.normalized!.counts.complexityDelta}
                    </p>
                  )}
                  {receipt.normalized!.issues.length > 0 && (
                    <ul className="space-y-1">
                      {receipt.normalized!.issues.slice(0, 20).map((issue, index) => (
                        <li
                          key={`${receipt._id}-${issue.file ?? "issue"}-${issue.line ?? 0}-${index}`}
                          className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground"
                        >
                          [{issue.severity.toUpperCase()}{issue.isBlocking ? ", BLOCKING" : ""}] {issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : "(no file)"} - {issue.message}
                        </li>
                      ))}
                      {receipt.normalized!.truncated && (
                        <li className="text-xs text-muted-foreground">
                          ... additional normalized issues omitted
                        </li>
                      )}
                    </ul>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No normalized scanner receipts available.
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

type NormalizedReceipt = {
  tool: "sonarqube" | "snyk";
  blocking: {
    isBlocking: boolean;
    reasonCode: string;
    reasonText: string;
  };
  counts: {
    introducedTotal: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    bugs: number;
    codeSmells: number;
    complexityDelta: number;
  };
  issues: Array<{
    severity: "critical" | "high" | "medium" | "low" | "info";
    isBlocking: boolean;
    file?: string;
    line?: number;
    message: string;
  }>;
  truncated: boolean;
};

function parseNormalized(raw?: string): NormalizedReceipt | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<NormalizedReceipt>;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.tool !== "sonarqube" && parsed.tool !== "snyk") return null;
    return {
      tool: parsed.tool,
      blocking: {
        isBlocking: Boolean(parsed.blocking?.isBlocking),
        reasonCode: parsed.blocking?.reasonCode ?? "unknown",
        reasonText: parsed.blocking?.reasonText ?? "No reason available",
      },
      counts: {
        introducedTotal: parsed.counts?.introducedTotal ?? 0,
        critical: parsed.counts?.critical ?? 0,
        high: parsed.counts?.high ?? 0,
        medium: parsed.counts?.medium ?? 0,
        low: parsed.counts?.low ?? 0,
        bugs: parsed.counts?.bugs ?? 0,
        codeSmells: parsed.counts?.codeSmells ?? 0,
        complexityDelta: parsed.counts?.complexityDelta ?? 0,
      },
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      truncated: Boolean(parsed.truncated),
    };
  } catch {
    return null;
  }
}
