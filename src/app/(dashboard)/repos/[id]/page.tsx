"use client";

import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { BountyStatusBadge } from "@/components/bounties/bounty-status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { GitBranch, Plus, ExternalLink, FileText } from "lucide-react";
import Link from "next/link";

export default function RepoDetailPage() {
  const params = useParams();
  const savedRepoId = params.id as Id<"savedRepos">;

  const repo = useQuery(api.savedRepos.getById, { savedRepoId });

  const bounties = useQuery(
    api.savedRepos.getBountiesForRepo,
    repo ? { repositoryUrl: repo.repositoryUrl } : "skip"
  );

  if (repo === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (repo === null) {
    return (
      <EmptyState
        icon={GitBranch}
        title="Repository not found"
        description="This repository may have been removed."
        actionLabel="My Repos"
        actionHref="/repos"
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <GitBranch className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-2xl font-bold">
              {repo.owner}/{repo.repo}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={repo.repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <ExternalLink className="h-3 w-3" />
              {repo.repositoryUrl}
            </a>
          </div>
          {repo.languages && repo.languages.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {repo.languages.map((lang) => (
                <Badge key={lang} variant="secondary" className="text-xs">
                  {lang}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <Link
          href={`/bounties/new?repoUrl=${encodeURIComponent(repo.repositoryUrl)}`}
        >
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create New Bounty
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Bounties ({bounties?.length ?? 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {bounties === undefined ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : bounties.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No bounties"
              description="No bounties have been created for this repository yet."
              actionLabel="Create Bounty"
              actionHref={`/bounties/new?repoUrl=${encodeURIComponent(repo.repositoryUrl)}`}
            />
          ) : (
            <div className="space-y-3">
              {bounties.map((bounty) => (
                <Link key={bounty._id} href={`/bounties/${bounty._id}`}>
                  <div className="flex items-center justify-between py-3 px-4 rounded-lg border hover:border-primary/50 transition-colors">
                    <div>
                      <p className="text-sm font-medium">{bounty.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {bounty.reward} {bounty.rewardCurrency}
                      </p>
                    </div>
                    <BountyStatusBadge status={bounty.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
