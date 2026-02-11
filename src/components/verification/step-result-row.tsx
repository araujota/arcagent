"use client";

import { CheckCircle, XCircle, MinusCircle, AlertTriangle } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { VerificationStep } from "@/lib/types";

const statusIcons = {
  pass: { icon: CheckCircle, color: "text-emerald-600" },
  fail: { icon: XCircle, color: "text-red-600" },
  skip: { icon: MinusCircle, color: "text-zinc-400" },
  error: { icon: AlertTriangle, color: "text-amber-600" },
};

export function StepResultRow({ step }: { step: VerificationStep }) {
  const { icon: Icon, color } = statusIcons[step.status];

  return (
    <Collapsible>
      <CollapsibleTrigger className="w-full flex items-center gap-3 py-2 px-3 hover:bg-muted/50 rounded-md transition-colors text-left">
        <Icon className={`h-4 w-4 shrink-0 ${color}`} />
        <span className="text-sm flex-1">{step.scenarioName}</span>
        <span className="text-xs text-muted-foreground">
          {step.executionTimeMs}ms
        </span>
      </CollapsibleTrigger>
      {step.output && (
        <CollapsibleContent>
          <pre className="text-xs font-mono bg-muted rounded p-3 ml-7 mt-1 mb-2 overflow-x-auto">
            {step.output}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
