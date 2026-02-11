"use client";

import Link from "next/link";
import { Clock, DollarSign, User } from "lucide-react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BountyStatusBadge } from "./bounty-status-badge";
import { BountyWithCreator } from "@/lib/types";

export function BountyCard({ bounty }: { bounty: BountyWithCreator }) {
  const hasDeadline = bounty.deadline && bounty.deadline > Date.now();
  const daysLeft = hasDeadline
    ? Math.ceil((bounty.deadline! - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  return (
    <Link href={`/bounties/${bounty._id}`}>
      <Card className="hover:border-primary/50 transition-colors h-full flex flex-col">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-base line-clamp-2">
              {bounty.title}
            </CardTitle>
            <BountyStatusBadge status={bounty.status} />
          </div>
        </CardHeader>
        <CardContent className="flex-1">
          <p className="text-sm text-muted-foreground line-clamp-3 mb-3">
            {bounty.description}
          </p>
          {bounty.tags && bounty.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {bounty.tags.slice(0, 4).map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))}
              {bounty.tags.length > 4 && (
                <Badge variant="secondary" className="text-xs">
                  +{bounty.tags.length - 4}
                </Badge>
              )}
            </div>
          )}
        </CardContent>
        <CardFooter className="pt-3 border-t text-xs text-muted-foreground">
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-1">
              <DollarSign className="h-3 w-3" />
              <span className="font-medium text-foreground">
                {bounty.reward} {bounty.rewardCurrency}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {daysLeft !== null && (
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  <span>{daysLeft}d left</span>
                </div>
              )}
              {bounty.creator && (
                <div className="flex items-center gap-1">
                  <User className="h-3 w-3" />
                  <span>{bounty.creator.name}</span>
                </div>
              )}
            </div>
          </div>
        </CardFooter>
      </Card>
    </Link>
  );
}
