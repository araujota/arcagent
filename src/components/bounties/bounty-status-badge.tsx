"use client";

import { Badge } from "@/components/ui/badge";
import { BountyStatus } from "@/lib/types";
import { BOUNTY_STATUS_LABELS } from "@/lib/constants";

const statusStyles: Record<BountyStatus, string> = {
  draft: "bg-zinc-100 text-zinc-600 border-zinc-200",
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  in_progress: "bg-blue-50 text-blue-700 border-blue-200",
  completed: "bg-violet-50 text-violet-700 border-violet-200",
  disputed: "bg-red-50 text-red-700 border-red-200",
};

export function BountyStatusBadge({ status }: { status: BountyStatus }) {
  return (
    <Badge variant="outline" className={statusStyles[status]}>
      {BOUNTY_STATUS_LABELS[status]}
    </Badge>
  );
}
