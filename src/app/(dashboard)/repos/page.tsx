"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GitBranch, Plus, MoreVertical, Eye, Trash2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

export default function ReposPage() {
  const repos = useQuery(api.savedRepos.listByUser);
  const hideRepo = useMutation(api.savedRepos.hide);

  const handleRemove = async (savedRepoId: string) => {
    try {
      await hideRepo({ savedRepoId: savedRepoId as any });
      toast.success("Repository removed");
    } catch {
      toast.error("Failed to remove repository");
    }
  };

  if (repos === undefined) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">My Repos</h1>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">My Repos</h1>
          <p className="text-muted-foreground">
            Repositories used across your bounties.
          </p>
        </div>
        <Link href="/bounties/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            New Bounty
          </Button>
        </Link>
      </div>

      {repos.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title="No repositories yet"
          description="Repositories will appear here when you create bounties with connected repos."
          actionLabel="Create Bounty"
          actionHref="/bounties/new"
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {repos.map((repo) => (
            <Card key={repo._id} className="group">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <CardTitle className="text-base font-semibold truncate">
                    {repo.owner}/{repo.repo}
                  </CardTitle>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <Link href={`/repos/${repo._id}`}>
                        <DropdownMenuItem>
                          <Eye className="h-4 w-4 mr-2" />
                          View Bounties
                        </DropdownMenuItem>
                      </Link>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => handleRemove(repo._id)}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {repo.languages && repo.languages.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {repo.languages.map((lang) => (
                      <Badge key={lang} variant="secondary" className="text-xs">
                        {lang}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span>{repo.bountyCount} bounties</span>
                  <span>{repo.completedCount} completed</span>
                </div>
                <div className="flex gap-2 pt-1">
                  <Link
                    href={`/bounties/new?repoUrl=${encodeURIComponent(repo.repositoryUrl)}`}
                  >
                    <Button variant="outline" size="sm">
                      <Plus className="h-3 w-3 mr-1" />
                      New Bounty
                    </Button>
                  </Link>
                  <Link href={`/repos/${repo._id}`}>
                    <Button variant="ghost" size="sm">
                      View
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
