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

type NormalizedIssue = {
  severity: "critical" | "high" | "medium" | "low" | "info";
  isBlocking: boolean;
  file?: string;
  line?: number;
  message: string;
};

type NormalizedDetails = {
  tool: "sonarqube" | "snyk";
  blocking: {
    isBlocking: boolean;
    reasonCode: string;
    reasonText: string;
  };
  counts: {
    introducedTotal: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    bugs: number;
    codeSmells: number;
    complexityDelta: number;
  };
  issues: NormalizedIssue[];
  truncated: boolean;
};

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
  const details = parseDetails(gate.detailsJson);
  const normalized = details?.normalized as Partial<NormalizedDetails> | undefined;
  const hasIssues = gate.issues && gate.issues.length > 0;
  const hasNormalized = Boolean(normalized && (normalized.tool === "snyk" || normalized.tool === "sonarqube"));
  const normalizedCounts = normalized?.counts ?? {
    introducedTotal: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    bugs: 0,
    codeSmells: 0,
    complexityDelta: 0,
  };
  const normalizedIssues = Array.isArray(normalized?.issues)
    ? normalized.issues as NormalizedIssue[]
    : [];
  const showExpandable = hasIssues || hasNormalized;

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
                {showExpandable && <ChevronDown className="h-4 w-4" />}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        {showExpandable && (
          <CollapsibleContent>
            <CardContent className="pt-0 space-y-3">
              {hasNormalized && normalized && (
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground">
                    Blocking reason:{" "}
                    <span className="text-foreground">
                      {normalized?.blocking?.reasonCode ?? "unknown"} - {normalized?.blocking?.reasonText ?? "No reason available"}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Introduced:{" "}
                    <span className="text-foreground">
                      {normalizedCounts.introducedTotal} (critical={normalizedCounts.critical}, high={normalizedCounts.high}, medium={normalizedCounts.medium}, low={normalizedCounts.low})
                    </span>
                  </div>
                  {normalized.tool === "sonarqube" && (
                    <div className="text-xs text-muted-foreground">
                      Sonar metrics:{" "}
                      <span className="text-foreground">
                        bugs={normalizedCounts.bugs}, code smells={normalizedCounts.codeSmells}, complexity delta={normalizedCounts.complexityDelta}
                      </span>
                    </div>
                  )}
                  {normalizedIssues.length > 0 && (
                    <ul className="space-y-1">
                      {normalizedIssues.slice(0, 20).map((issue, i) => (
                        <li
                          key={`${issue.file ?? "issue"}-${issue.line ?? 0}-${i}`}
                          className="text-sm text-muted-foreground font-mono bg-muted rounded px-2 py-1"
                        >
                          [{issue.severity.toUpperCase()}{issue.isBlocking ? ", BLOCKING" : ""}] {formatLocation(issue)} - {issue.message}
                        </li>
                      ))}
                      {normalized.truncated && (
                        <li className="text-xs text-muted-foreground">... additional normalized issues omitted</li>
                      )}
                    </ul>
                  )}
                </div>
              )}
              {hasIssues && (
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
              )}
            </CardContent>
          </CollapsibleContent>
        )}
      </Collapsible>
    </Card>
  );
}

function parseDetails(detailsJson?: string): Record<string, unknown> | undefined {
  if (!detailsJson) return undefined;
  try {
    const parsed = JSON.parse(detailsJson);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function formatLocation(issue: NormalizedIssue): string {
  if (!issue.file) return "(no file)";
  return issue.line ? `${issue.file}:${issue.line}` : issue.file;
}
