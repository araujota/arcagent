"use client";

import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface GherkinEditorProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  readOnly?: boolean;
}

export function GherkinEditor({
  value,
  onChange,
  label,
  placeholder = "Feature: My Feature\n\n  Scenario: Basic scenario\n    Given some precondition\n    When some action is performed\n    Then some result is expected",
  readOnly = false,
}: GherkinEditorProps) {
  return (
    <div className="space-y-2">
      {label && <Label>{label}</Label>}
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        className="font-mono text-sm min-h-[300px] resize-y"
        spellCheck={false}
      />
    </div>
  );
}

export function GherkinDisplay({ content }: { content: string }) {
  return (
    <pre className="bg-muted rounded-lg p-4 text-sm font-mono overflow-x-auto whitespace-pre-wrap">
      {content}
    </pre>
  );
}
