"use client";

import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../../../../convex/_generated/api";
import { Id } from "../../../../../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ExternalLink, FileText, GitCommit, User } from "lucide-react";
import Link from "next/link";
import { SUBMISSION_STATUS_LABELS } from "@/lib/constants";

export default function SubmissionDetailPage() {
  const params = useParams();
  const submissionId = params.subId as Id<"submissions">;
  const bountyId = params.id as Id<"bounties">;

  const submission = useQuery(api.submissions.getById, { submissionId });
  const verification = useQuery(api.verifications.getBySubmission, {
    submissionId,
  });

  if (submission === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (submission === null) {
    return (
      <EmptyState
        icon={FileText}
        title="Submission not found"
        description="This submission may have been removed or doesn't exist."
        actionLabel="Back to Bounty"
        actionHref={`/bounties/${bountyId}`}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Submission</h1>
            <Badge
              variant={
                submission.status === "passed"
                  ? "default"
                  : submission.status === "failed"
                    ? "destructive"
                    : "secondary"
              }
            >
              {SUBMISSION_STATUS_LABELS[submission.status]}
            </Badge>
          </div>
          {submission.bounty && (
            <p className="text-sm text-muted-foreground">
              For bounty:{" "}
              <Link
                href={`/bounties/${bountyId}`}
                className="underline hover:text-foreground"
              >
                {submission.bounty.title}
              </Link>
            </p>
          )}
        </div>

        {verification && (
          <Button asChild variant="outline">
            <Link
              href={`/bounties/${bountyId}/submissions/${submissionId}/verification`}
            >
              View Verification Results
            </Link>
          </Button>
        )}
      </div>

      <Separator />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Agent</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">
                {submission.agent?.name ?? "Unknown"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Repository</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2">
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
              <a
                href={submission.repositoryUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm hover:underline font-mono"
              >
                {submission.repositoryUrl}
              </a>
            </div>
            <div className="flex items-center gap-2">
              <GitCommit className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-mono">
                {submission.commitHash}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {submission.description && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Description</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">
              {submission.description}
            </p>
          </CardContent>
        </Card>
      )}

      {verification && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Verification Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4 text-sm">
              <div>
                Status:{" "}
                <Badge
                  variant={
                    verification.status === "passed"
                      ? "default"
                      : verification.status === "failed"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {verification.status}
                </Badge>
              </div>
              {verification.startedAt && (
                <span className="text-muted-foreground">
                  Started:{" "}
                  {new Date(verification.startedAt).toLocaleString()}
                </span>
              )}
              {verification.completedAt && (
                <span className="text-muted-foreground">
                  Completed:{" "}
                  {new Date(verification.completedAt).toLocaleString()}
                </span>
              )}
            </div>
            {verification.result && (
              <p className="text-sm mt-2 text-muted-foreground">
                {verification.result}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
