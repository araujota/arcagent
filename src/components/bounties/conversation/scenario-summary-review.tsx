"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, List } from "lucide-react";

interface ScenarioSummaryReviewProps {
  gherkinPublic: string;
  gherkinHidden: string;
  onContinue: () => void;
}

interface ParsedFeature {
  name: string;
  scenarios: string[];
}

function parseGherkinFeatures(gherkin: string): ParsedFeature[] {
  const features: ParsedFeature[] = [];
  let currentFeature: ParsedFeature | null = null;

  for (const line of gherkin.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Feature:")) {
      currentFeature = {
        name: trimmed.replace("Feature:", "").trim(),
        scenarios: [],
      };
      features.push(currentFeature);
    } else if (
      trimmed.startsWith("Scenario:") ||
      trimmed.startsWith("Scenario Outline:")
    ) {
      const name = trimmed
        .replace("Scenario Outline:", "")
        .replace("Scenario:", "")
        .trim();
      if (currentFeature) {
        currentFeature.scenarios.push(name);
      } else {
        // Scenario without a feature header
        currentFeature = { name: "Tests", scenarios: [name] };
        features.push(currentFeature);
      }
    }
  }

  return features;
}

function countScenarios(gherkin: string): number {
  return (
    (gherkin.match(/Scenario:/g) || []).length +
    (gherkin.match(/Scenario Outline:/g) || []).length
  );
}

export function ScenarioSummaryReview({
  gherkinPublic,
  gherkinHidden,
  onContinue,
}: ScenarioSummaryReviewProps) {
  const publicFeatures = parseGherkinFeatures(gherkinPublic);
  const hiddenCount = countScenarios(gherkinHidden);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <List className="h-4 w-4" />
            <CardTitle className="text-sm">Test Specification Summary</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {publicFeatures.map((feature, i) => (
          <div key={i} className="space-y-1.5">
            <p className="text-sm font-medium">{feature.name}</p>
            <ul className="space-y-1 ml-4">
              {feature.scenarios.map((scenario, j) => (
                <li
                  key={j}
                  className="text-sm text-muted-foreground flex items-start gap-2"
                >
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/50 shrink-0" />
                  {scenario}
                </li>
              ))}
            </ul>
          </div>
        ))}

        {hiddenCount > 0 && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              +{hiddenCount} hidden
            </Badge>
            <span className="text-xs text-muted-foreground">
              Additionally, {hiddenCount} hidden scenario
              {hiddenCount > 1 ? "s" : ""} will verify edge cases during
              verification.
            </span>
          </div>
        )}

        <Button onClick={onContinue} className="w-full gap-1">
          <CheckCircle className="h-3.5 w-3.5" />
          Looks Good — Continue
        </Button>
      </CardContent>
    </Card>
  );
}
