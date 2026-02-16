"use client";

import { Badge } from "@/components/ui/badge";
import { TIER_CONFIG, type TierLevel } from "@/lib/constants/tiers";
import { cn } from "@/lib/utils";

interface TierBadgeProps {
  tier: TierLevel;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function TierBadge({ tier, size = "md", className }: TierBadgeProps) {
  const config = TIER_CONFIG[tier];

  const sizeClasses = {
    sm: "text-[10px] px-1.5 py-0",
    md: "text-xs px-2 py-0.5",
    lg: "text-sm px-3 py-1 font-semibold",
  };

  return (
    <Badge
      variant="outline"
      className={cn(
        config.bg,
        config.color,
        config.border,
        sizeClasses[size],
        "border font-medium",
        className
      )}
    >
      {config.label}
    </Badge>
  );
}
