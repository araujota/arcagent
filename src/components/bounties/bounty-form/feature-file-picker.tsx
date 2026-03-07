"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { GherkinDisplay } from "@/components/shared/gherkin-editor";
import { extractScenarioNames } from "../../../../convex/lib/gherkinValidator";
import { Eye } from "lucide-react";

interface FeatureFile {
  filePath: string;
  content: string;
}

interface FeatureFilePickerProps {
  featureFiles: FeatureFile[];
  onImport: (content: string, visibility: "public" | "hidden") => void;
}

export function FeatureFilePicker({ featureFiles, onImport }: FeatureFilePickerProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (featureFiles.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No .feature files detected in the connected repository.
      </p>
    );
  }

  const toggle = (filePath: string) => {
    setSelected((prev) => {
      const next = new Set<string>(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  };

  const handleImport = (visibility: "public" | "hidden") => {
    const combined = featureFiles
      .filter((f) => selected.has(f.filePath))
      .map((f) => f.content)
      .join("\n\n");

    if (combined) {
      onImport(combined, visibility);
      setSelected(new Set());
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Select .feature files from the repository to import as test scenarios.
      </p>
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {featureFiles.map((file) => {
          const scenarios = extractScenarioNames(file.content);
          return (
            <div
              key={file.filePath}
              className="flex items-center justify-between rounded-md border px-3 py-2"
            >
              <div className="flex items-center gap-3">
                <Checkbox
                  checked={selected.has(file.filePath)}
                  onCheckedChange={() => toggle(file.filePath)}
                />
                <div>
                  <p className="text-sm font-mono">{file.filePath}</p>
                  <p className="text-xs text-muted-foreground">
                    {scenarios.length} scenario{scenarios.length !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="ghost" size="sm">
                    <Eye className="h-4 w-4" />
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-2xl max-h-[70vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle className="font-mono text-sm">
                      {file.filePath}
                    </DialogTitle>
                  </DialogHeader>
                  <GherkinDisplay content={file.content} />
                </DialogContent>
              </Dialog>
            </div>
          );
        })}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={selected.size === 0}
          onClick={() => handleImport("public")}
        >
          Import as Public
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={selected.size === 0}
          onClick={() => handleImport("hidden")}
        >
          Import as Hidden
        </Button>
      </div>
    </div>
  );
}
