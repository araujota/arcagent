"use client";

import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle, MinusCircle, AlertTriangle } from "lucide-react";
import { VerificationStep } from "@/lib/types";

interface VerificationProgressProps {
  steps: VerificationStep[];
  status: "pending" | "running" | "passed" | "failed";
}

export function VerificationProgress({
  steps,
  status,
}: VerificationProgressProps) {
  const passed = steps.filter((s) => s.status === "pass").length;
  const failed = steps.filter((s) => s.status === "fail").length;
  const skipped = steps.filter((s) => s.status === "skip").length;
  const errors = steps.filter((s) => s.status === "error").length;
  const total = steps.length;
  const progressValue = total > 0 ? (passed / total) * 100 : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Verification Progress</h3>
        <Badge
          variant={
            status === "passed"
              ? "default"
              : status === "failed"
                ? "destructive"
                : "secondary"
          }
        >
          {status}
        </Badge>
      </div>

      <Progress value={progressValue} className="h-2" />

      <div className="flex gap-4 text-sm">
        <div className="flex items-center gap-1 text-emerald-600">
          <CheckCircle className="h-4 w-4" />
          <span>{passed} passed</span>
        </div>
        <div className="flex items-center gap-1 text-red-600">
          <XCircle className="h-4 w-4" />
          <span>{failed} failed</span>
        </div>
        <div className="flex items-center gap-1 text-zinc-500">
          <MinusCircle className="h-4 w-4" />
          <span>{skipped} skipped</span>
        </div>
        {errors > 0 && (
          <div className="flex items-center gap-1 text-amber-600">
            <AlertTriangle className="h-4 w-4" />
            <span>{errors} errors</span>
          </div>
        )}
      </div>
    </div>
  );
}
