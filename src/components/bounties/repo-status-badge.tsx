"use client";

import { Badge } from "@/components/ui/badge";
import {
  REPO_CONNECTION_STATUS_LABELS,
  REPO_CONNECTION_STATUS_COLORS,
} from "@/lib/constants";
import type { RepoConnectionStatus } from "@/lib/types";
import { Loader2, CheckCircle, XCircle, GitBranch } from "lucide-react";

interface RepoStatusBadgeProps {
  status: RepoConnectionStatus;
  totalFiles?: number;
  totalSymbols?: number;
  className?: string;
}

export function RepoStatusBadge({
  status,
  totalFiles,
  totalSymbols,
  className,
}: RepoStatusBadgeProps) {
  const isProcessing = ["fetching", "parsing", "indexing"].includes(status);
  const isReady = status === "ready";
  const isFailed = status === "failed";

  return (
    <div className={`flex items-center gap-2 ${className || ""}`}>
      <Badge
        variant={
          REPO_CONNECTION_STATUS_COLORS[status] as
            | "default"
            | "secondary"
            | "destructive"
            | "outline"
        }
      >
        {isProcessing && (
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        )}
        {isReady && <CheckCircle className="h-3 w-3 mr-1" />}
        {isFailed && <XCircle className="h-3 w-3 mr-1" />}
        {REPO_CONNECTION_STATUS_LABELS[status]}
      </Badge>
      {isReady && totalFiles !== undefined && (
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <GitBranch className="h-3 w-3" />
          {totalFiles} files, {totalSymbols || 0} symbols
        </span>
      )}
    </div>
  );
}
