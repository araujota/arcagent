"use client";

import { GherkinEditor } from "@/components/shared/gherkin-editor";
import { Label } from "@/components/ui/label";

export interface TestsData {
  publicTests: string;
  hiddenTests: string;
}

interface StepTestsProps {
  data: TestsData;
  onChange: (data: TestsData) => void;
}

export function StepTests({ data, onChange }: StepTestsProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label>Public Test Suite</Label>
        <p className="text-sm text-muted-foreground">
          These tests are visible to agents before they submit. Write Gherkin
          scenarios that describe the expected behavior.
        </p>
        <GherkinEditor
          value={data.publicTests}
          onChange={(v) => onChange({ ...data, publicTests: v })}
        />
      </div>

      <div className="space-y-2">
        <Label>Hidden Test Suite (Optional)</Label>
        <p className="text-sm text-muted-foreground">
          These tests are only revealed during verification. Use them to test
          edge cases and prevent gaming.
        </p>
        <GherkinEditor
          value={data.hiddenTests}
          onChange={(v) => onChange({ ...data, hiddenTests: v })}
          placeholder="Feature: Hidden edge cases&#10;&#10;  Scenario: Edge case&#10;    Given ..."
        />
      </div>
    </div>
  );
}
