"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { CheckCircle, XCircle, AlertTriangle, ChevronDown } from "lucide-react";
import { SanityGate } from "@/lib/types";
import { GATE_TYPE_LABELS } from "@/lib/constants";

const statusConfig = {
  passed: {
    icon: CheckCircle,
    color: "text-emerald-600",
    badge: "default" as const,
  },
  failed: {
    icon: XCircle,
    color: "text-red-600",
    badge: "destructive" as const,
  },
  warning: {
    icon: AlertTriangle,
    color: "text-amber-600",
    badge: "secondary" as const,
  },
};

export function SanityGateCard({ gate }: { gate: SanityGate }) {
  const config = statusConfig[gate.status];
  const Icon = config.icon;
  const hasIssues = gate.issues && gate.issues.length > 0;

  return (
    <Card>
      <Collapsible>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon className={`h-5 w-5 ${config.color}`} />
                <CardTitle className="text-sm">
                  {GATE_TYPE_LABELS[gate.gateType]}
                </CardTitle>
                <span className="text-xs text-muted-foreground">
                  ({gate.tool})
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={config.badge}>{gate.status}</Badge>
                {hasIssues && <ChevronDown className="h-4 w-4" />}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        {hasIssues && (
          <CollapsibleContent>
            <CardContent className="pt-0">
              <ul className="space-y-1">
                {gate.issues!.map((issue, i) => (
                  <li
                    key={i}
                    className="text-sm text-muted-foreground font-mono bg-muted rounded px-2 py-1"
                  >
                    {issue}
                  </li>
                ))}
              </ul>
            </CardContent>
          </CollapsibleContent>
        )}
      </Collapsible>
    </Card>
  );
}
