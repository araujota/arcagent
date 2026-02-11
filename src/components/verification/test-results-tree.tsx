"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { StepResultRow } from "./step-result-row";
import { VerificationStep } from "@/lib/types";

interface TestResultsTreeProps {
  steps: VerificationStep[];
}

export function TestResultsTree({ steps }: TestResultsTreeProps) {
  // Group steps by feature name
  const grouped = steps.reduce(
    (acc, step) => {
      if (!acc[step.featureName]) {
        acc[step.featureName] = [];
      }
      acc[step.featureName].push(step);
      return acc;
    },
    {} as Record<string, VerificationStep[]>
  );

  const featureNames = Object.keys(grouped);

  if (featureNames.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No test results available yet.
      </p>
    );
  }

  return (
    <Accordion type="multiple" defaultValue={featureNames} className="space-y-2">
      {featureNames.map((feature) => {
        const featureSteps = grouped[feature].sort(
          (a, b) => a.stepNumber - b.stepNumber
        );
        const passed = featureSteps.filter((s) => s.status === "pass").length;
        const total = featureSteps.length;

        return (
          <AccordionItem key={feature} value={feature} className="border rounded-lg px-3">
            <AccordionTrigger className="hover:no-underline">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">{feature}</span>
                <span className="text-xs text-muted-foreground">
                  {passed}/{total} passed
                </span>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-1">
                {featureSteps.map((step) => (
                  <StepResultRow key={step._id} step={step} />
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}
