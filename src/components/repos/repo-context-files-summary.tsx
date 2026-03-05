"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";

type RepoContextSummaryRow = {
  _id: Id<"repoContextFiles">;
  filenameOriginal: string;
  extractionStatus: "processing" | "ready" | "failed";
};

function isValidRepoUrl(url: string): boolean {
  const trimmed = url.trim();
  return (
    /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(trimmed) ||
    /^https?:\/\/gitlab\.com\/[\w.-]+(?:\/[\w.-]+)+(?:\.git)?\/?$/i.test(trimmed) ||
    /^https?:\/\/bitbucket\.org\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(trimmed)
  );
}

export function RepoContextFilesSummary({ repositoryUrl }: { repositoryUrl: string }) {
  const featureEnabled = process.env.NEXT_PUBLIC_ENABLE_REPO_CONTEXT_FILES === "true";
  const validRepoUrl = isValidRepoUrl(repositoryUrl);

  const rows = useQuery(
    api.repoContextFiles.listByRepositoryUrl,
    featureEnabled && validRepoUrl ? { repositoryUrl } : "skip",
  ) as RepoContextSummaryRow[] | undefined;

  if (!featureEnabled || !validRepoUrl) return null;
  if (!rows || rows.length === 0) return null;

  const readyCount = rows.filter((row) => row.extractionStatus === "ready").length;
  const processingCount = rows.filter((row) => row.extractionStatus === "processing").length;
  const failedCount = rows.filter((row) => row.extractionStatus === "failed").length;

  return (
    <div>
      <h3 className="text-sm font-medium text-muted-foreground mb-1">
        Repository Context Files
      </h3>
      <div className="flex items-center gap-2 mb-2">
        <Badge variant="secondary">{rows.length} total</Badge>
        <Badge>{readyCount} ready</Badge>
        {processingCount > 0 && <Badge variant="secondary">{processingCount} processing</Badge>}
        {failedCount > 0 && <Badge variant="destructive">{failedCount} failed</Badge>}
      </div>
      <ul className="text-sm space-y-1">
        {rows.slice(0, 8).map((row) => (
          <li key={row._id} className="truncate">
            {row.filenameOriginal}
          </li>
        ))}
      </ul>
      {rows.length > 8 && (
        <p className="text-xs text-muted-foreground mt-1">
          +{rows.length - 8} more files
        </p>
      )}
      <p className="text-xs text-muted-foreground mt-2">
        Back to Config to add or remove files.
      </p>
    </div>
  );
}
