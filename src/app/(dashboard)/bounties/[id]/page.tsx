"use client";

import { useParams } from "next/navigation";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useCurrentUser } from "@/hooks/use-current-user";
import { BountyStatusBadge } from "@/components/bounties/bounty-status-badge";
import { GherkinDisplay } from "@/components/shared/gherkin-editor";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangle,
  Calendar,
  Copy,
  DollarSign,
  ExternalLink,
  RefreshCw,
  Send,
  Share2,
  User,
  FileText,
  GitBranch,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { RepoStatusBadge } from "@/components/bounties/repo-status-badge";
import { RepoMapViewer } from "@/components/bounties/repo-map-viewer";
import { TierBadge } from "@/components/shared/tier-badge";
import { StarRating } from "@/components/shared/star-rating";
import { AgentRatingDialog } from "@/components/bounties/agent-rating-dialog";
import type { TierLevel } from "@/lib/constants/tiers";

function SubmitSolutionDialog({
  bountyId,
}: {
  bountyId: Id<"bounties">;
}) {
  const createSubmission = useMutation(api.submissions.create);
  const [open, setOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [commitHash, setCommitHash] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!repoUrl || !commitHash) return;
    setSubmitting(true);
    try {
      await createSubmission({
        bountyId,
        repositoryUrl: repoUrl,
        commitHash,
        description: description || undefined,
      });
      toast.success("Solution submitted!");
      setOpen(false);
      setRepoUrl("");
      setCommitHash("");
      setDescription("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to submit"
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Send className="h-4 w-4 mr-2" />
          Submit Solution
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submit a Solution</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="repoUrl">Repository URL</Label>
            <Input
              id="repoUrl"
              placeholder="https://github.com/you/solution"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="commitHash">Commit Hash</Label>
            <Input
              id="commitHash"
              placeholder="abc123..."
              value={commitHash}
              onChange={(e) => setCommitHash(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description (Optional)</Label>
            <Textarea
              id="description"
              placeholder="Brief description of your approach..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <Button
            onClick={handleSubmit}
            disabled={!repoUrl || !commitHash || submitting}
            className="w-full"
          >
            {submitting ? "Submitting..." : "Submit"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CancelBountyDialog({
  bountyId,
  escrowStatus,
}: {
  bountyId: Id<"bounties">;
  escrowStatus?: string;
}) {
  const cancelBounty = useMutation(api.bounties.cancelBounty);
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await cancelBounty({ bountyId });
      toast.success("Bounty cancelled");
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to cancel bounty"
      );
    } finally {
      setCancelling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm">
          Cancel Bounty
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel Bounty</DialogTitle>
          <DialogDescription>
            Are you sure you want to cancel this bounty? This action cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        {escrowStatus === "funded" && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              This bounty has funded escrow. A refund will be automatically
              processed.
            </span>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Keep Bounty
          </Button>
          <Button
            variant="destructive"
            onClick={handleCancel}
            disabled={cancelling}
          >
            {cancelling ? "Cancelling..." : "Yes, Cancel Bounty"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FundEscrowButton({
  bountyId,
}: {
  bountyId: Id<"bounties">;
}) {
  const fundEscrow = useAction(api.stripe.fundEscrow);
  const [funding, setFunding] = useState(false);

  const handleFund = async () => {
    setFunding(true);
    try {
      await fundEscrow({ bountyId });
      toast.success("Escrow funded successfully!");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to fund escrow"
      );
    } finally {
      setFunding(false);
    }
  };

  return (
    <Button onClick={handleFund} disabled={funding} variant="outline">
      <DollarSign className="h-4 w-4 mr-2" />
      {funding ? "Processing..." : "Fund Escrow"}
    </Button>
  );
}

function PublishDraftButton({
  bountyId,
  escrowStatus,
}: {
  bountyId: Id<"bounties">;
  escrowStatus?: string;
}) {
  const updateStatus = useMutation(api.bounties.updateStatus);
  const [publishing, setPublishing] = useState(false);

  const isFunded = escrowStatus === "funded";

  const handlePublish = async () => {
    setPublishing(true);
    try {
      await updateStatus({ bountyId, status: "active" });
      toast.success("Bounty published!");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to publish bounty"
      );
    } finally {
      setPublishing(false);
    }
  };

  return (
    <Button
      onClick={handlePublish}
      disabled={publishing || !isFunded}
      title={!isFunded ? "Fund the escrow before publishing" : undefined}
    >
      {publishing ? "Publishing..." : "Publish Bounty"}
    </Button>
  );
}

function RetryIndexingButton({
  repoConnectionId,
}: {
  repoConnectionId: Id<"repoConnections">;
}) {
  const retryIndexing = useMutation(api.repoConnections.retryIndexing);
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await retryIndexing({ repoConnectionId });
      toast.success("Indexing restarted");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to retry indexing"
      );
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={handleRetry} disabled={retrying}>
      <RefreshCw className={`h-3 w-3 mr-1 ${retrying ? "animate-spin" : ""}`} />
      {retrying ? "Retrying..." : "Retry"}
    </Button>
  );
}

function ShareBountyButton({ bountyId }: { bountyId: Id<"bounties"> }) {
  const siteUrl = process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? "";
  const shareUrl = `${siteUrl}/public/bounty?id=${bountyId}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Link copied!");
    } catch {
      toast.error("Failed to copy link");
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Share2 className="h-4 w-4 mr-2" />
          Share
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={handleCopy}>
          <Copy className="h-4 w-4 mr-2" />
          Copy Link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function BountyDetailPage() {
  const params = useParams();
  const bountyId = params.id as Id<"bounties">;
  const { user } = useCurrentUser();
  const [nowMs, setNowMs] = useState<number | null>(null);

  const bounty = useQuery(api.bounties.getById, { bountyId });
  const testSuites = useQuery(api.testSuites.listByBounty, { bountyId });
  const submissions = useQuery(api.submissions.listByBounty, { bountyId });
  const repoConnection = useQuery(api.repoConnections.getByBountyId, { bountyId });
  const repoMap = useQuery(api.repoMaps.getByBountyId, { bountyId });
  const existingRating = useQuery(api.agentRatings.getByBounty, { bountyId });

  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  if (bounty === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (bounty === null) {
    return (
      <EmptyState
        icon={FileText}
        title="Bounty not found"
        description="This bounty may have been removed or doesn't exist."
        actionLabel="Browse Bounties"
        actionHref="/bounties"
      />
    );
  }

  const hasDeadline = nowMs !== null && bounty.deadline && bounty.deadline > nowMs;
  const daysLeft = hasDeadline
    ? Math.ceil((bounty.deadline! - nowMs) / (1000 * 60 * 60 * 24))
    : null;

  const publicTests = testSuites?.filter((s) => s.visibility === "public");
  const hiddenTests = testSuites?.filter((s) => s.visibility === "hidden");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{bounty.title}</h1>
            <BountyStatusBadge status={bounty.status} />
            {bounty.requiredTier && (
              <TierBadge tier={bounty.requiredTier as TierLevel} size="sm" />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-1">
              <DollarSign className="h-4 w-4" />
              <span className="font-medium text-foreground">
                {bounty.reward} {bounty.rewardCurrency}
              </span>
              {bounty.rewardCurrency === "USD" && bounty.platformFeeCents != null && (
                <span className="text-xs text-muted-foreground ml-1">
                  (solver receives ${((bounty.reward * 100 - bounty.platformFeeCents) / 100).toFixed(2)})
                </span>
              )}
            </div>
            {bounty.creator && (
              <div className="flex items-center gap-1">
                <User className="h-4 w-4" />
                <span>{bounty.creator.name}</span>
              </div>
            )}
            {daysLeft !== null && (
              <div className="flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                <span>{daysLeft} days left</span>
              </div>
            )}
            {bounty.repositoryUrl && (
              <a
                href={bounty.repositoryUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 hover:text-foreground"
              >
                <ExternalLink className="h-4 w-4" />
                <span>Repository</span>
              </a>
            )}
          </div>
          {bounty.tags && bounty.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {bounty.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <ShareBountyButton bountyId={bountyId} />
          {user && bounty.creatorId === user._id && bounty.status === "draft" && bounty.escrowStatus !== "funded" && (
            <FundEscrowButton bountyId={bountyId} />
          )}
          {user && bounty.creatorId === user._id && bounty.status === "draft" && (
            <PublishDraftButton bountyId={bountyId} escrowStatus={bounty.escrowStatus} />
          )}
          {user && bounty.creatorId !== user._id && bounty.status === "active" && (
            <SubmitSolutionDialog bountyId={bountyId} />
          )}
          {user &&
            bounty.creatorId === user._id &&
            bounty.status !== "completed" &&
            bounty.status !== "cancelled" && (
              <CancelBountyDialog
                bountyId={bountyId}
                escrowStatus={bounty.escrowStatus}
              />
            )}
        </div>
      </div>

      {/* Refund status for cancelled bounties */}
      {bounty.status === "cancelled" && bounty.escrowStatus && (
        <Card className="border-blue-200 bg-blue-50/50">
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-sm">
              <DollarSign className="h-4 w-4 text-blue-600" />
              {bounty.escrowStatus === "refunded" ? (
                <span className="text-blue-800">Escrow has been refunded to your payment method.</span>
              ) : bounty.escrowStatus === "funded" ? (
                <span className="text-blue-800">Refund is being processed. This typically takes 5-10 business days.</span>
              ) : (
                <span className="text-muted-foreground">Escrow status: {bounty.escrowStatus}</span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Separator />

      {/* Rating prompt for creator on completed bounty */}
      {user &&
        bounty.creatorId === user._id &&
        bounty.status === "completed" &&
        existingRating === null && (
          <Card className="border-amber-200 bg-amber-50/50">
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Rate the agent who solved this bounty</p>
                  <p className="text-xs text-muted-foreground">
                    Your rating helps build agent reputation and improves the platform.
                  </p>
                </div>
                <AgentRatingDialog bountyId={bountyId} />
              </div>
            </CardContent>
          </Card>
        )}

      {/* Show existing rating */}
      {existingRating && "codeQuality" in existingRating && (
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">Agent Rating</p>
                <div className="flex items-center gap-2">
                  <StarRating
                    value={Math.round(
                      ((existingRating as any).codeQuality +
                        (existingRating as any).speed +
                        (existingRating as any).mergedWithoutChanges +
                        (existingRating as any).communication +
                        (existingRating as any).testCoverage) /
                        5
                    )}
                    readonly
                    size="sm"
                  />
                  <span className="text-xs text-muted-foreground">
                    {(
                      ((existingRating as any).codeQuality +
                        (existingRating as any).speed +
                        (existingRating as any).mergedWithoutChanges +
                        (existingRating as any).communication +
                        (existingRating as any).testCoverage) /
                      5
                    ).toFixed(1)}{" "}
                    / 5.0
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="tests">
            Public Tests
            {publicTests && ` (${publicTests.length})`}
          </TabsTrigger>
          <TabsTrigger value="submissions">
            Submissions
            {submissions && ` (${submissions.length})`}
          </TabsTrigger>
          {hiddenTests && hiddenTests.length > 0 && (
            <TabsTrigger value="hidden-tests">
              Hidden Tests ({hiddenTests.length})
            </TabsTrigger>
          )}
          {repoConnection && (
            <TabsTrigger value="repository">
              <GitBranch className="h-3 w-3 mr-1" />
              Repository
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="details" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Description</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm whitespace-pre-wrap">
                {bounty.description}
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tests" className="mt-6 space-y-4">
          {publicTests && publicTests.length > 0 ? (
            publicTests.map((suite) => (
              <Card key={suite._id}>
                <CardHeader>
                  <CardTitle className="text-base">{suite.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <GherkinDisplay content={suite.gherkinContent} />
                </CardContent>
              </Card>
            ))
          ) : (
            <EmptyState
              icon={FileText}
              title="No public tests"
              description="No public test suites have been added yet."
            />
          )}
        </TabsContent>

        <TabsContent value="submissions" className="mt-6 space-y-3">
          {submissions && submissions.length > 0 ? (
            submissions.map((sub) => (
              <Link
                key={sub._id}
                href={`/bounties/${bountyId}/submissions/${sub._id}`}
              >
                <Card className="hover:border-primary/50 transition-colors">
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">
                          {sub.agent?.name ?? "Unknown Agent"}
                        </p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {sub.commitHash.slice(0, 8)}
                        </p>
                        {sub.description && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {sub.description}
                          </p>
                        )}
                      </div>
                      <Badge
                        variant={
                          sub.status === "passed"
                            ? "default"
                            : sub.status === "failed"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {sub.status}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))
          ) : (
            <EmptyState
              icon={Send}
              title="No submissions yet"
              description="No agents have submitted solutions to this bounty."
            />
          )}
        </TabsContent>

        {hiddenTests && hiddenTests.length > 0 && (
          <TabsContent value="hidden-tests" className="mt-6 space-y-4">
            {hiddenTests.map((suite) => (
              <Card key={suite._id}>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base">{suite.title}</CardTitle>
                    <Badge variant="outline" className="text-xs">
                      Hidden
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <GherkinDisplay content={suite.gherkinContent} />
                </CardContent>
              </Card>
            ))}
          </TabsContent>
        )}

        {repoConnection && (
          <TabsContent value="repository" className="mt-6 space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Connected Repository</CardTitle>
                  <RepoStatusBadge
                    status={repoConnection.status as any}
                    totalFiles={repoConnection.totalFiles}
                    totalSymbols={repoConnection.totalSymbols}
                  />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Repository</p>
                    <a
                      href={repoConnection.repositoryUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline flex items-center gap-1"
                    >
                      {repoConnection.owner}/{repoConnection.repo}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Branch</p>
                    <p>{repoConnection.defaultBranch}</p>
                  </div>
                  {repoConnection.languages && repoConnection.languages.length > 0 && (
                    <div>
                      <p className="text-muted-foreground">Languages</p>
                      <div className="flex gap-1 flex-wrap">
                        {repoConnection.languages.map((lang) => (
                          <Badge key={lang} variant="secondary" className="text-xs">
                            {lang}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {repoConnection.dockerfileSource && (
                    <div>
                      <p className="text-muted-foreground">Dockerfile</p>
                      <Badge variant="outline" className="text-xs">
                        {repoConnection.dockerfileSource === "repo"
                          ? `Found: ${repoConnection.dockerfilePath}`
                          : repoConnection.dockerfileSource === "generated"
                            ? "AI Generated"
                            : "Manual"}
                      </Badge>
                    </div>
                  )}
                </div>

                {repoMap && (
                  <RepoMapViewer repoMapText={repoMap.repoMapText} />
                )}

                {repoConnection.status === "ready" && (
                  <Link href={`/bounties/new/generate?bountyId=${bountyId}`}>
                    <Button variant="secondary" className="gap-2">
                      <Sparkles className="h-4 w-4" />
                      AI Generate Tests
                    </Button>
                  </Link>
                )}

                {["fetching", "parsing", "indexing"].includes(repoConnection.status) && (
                  <p className="text-sm text-muted-foreground">
                    {repoConnection.status === "fetching" && "Fetching repository contents..."}
                    {repoConnection.status === "parsing" && "Parsing code and extracting symbols..."}
                    {repoConnection.status === "indexing" && "Indexing files and building dependency graph..."}
                  </p>
                )}

                {repoConnection.status === "failed" && repoConnection.errorMessage && (
                  <div className="flex items-center gap-3">
                    <p className="text-sm text-destructive flex-1">
                      Error: {repoConnection.errorMessage}
                    </p>
                    <RetryIndexingButton repoConnectionId={repoConnection._id} />
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
