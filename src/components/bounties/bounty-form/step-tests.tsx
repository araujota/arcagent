"use client";

import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { GherkinEditor } from "@/components/shared/gherkin-editor";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FeatureFilePicker } from "./feature-file-picker";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export interface TestsData {
  publicTests: string;
  hiddenTests: string;
  gherkinSource?: "manual" | "repo" | "url" | "mixed";
}

interface StepTestsProps {
  data: TestsData;
  onChange: (data: TestsData) => void;
  bountyId?: Id<"bounties">;
}

export function StepTests({ data, onChange, bountyId }: StepTestsProps) {
  const [urlInput, setUrlInput] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const [urlPreview, setUrlPreview] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);

  const detectedFeatures = useQuery(
    api.repoConnections.getDetectedFeatures,
    bountyId ? { bountyId } : "skip"
  );

  const fetchGherkinFromUrl = useAction(api.bounties.fetchGherkinFromUrl);
  const canImportFromRepo = Boolean(bountyId);

  const handleRepoImport = (content: string, visibility: "public" | "hidden") => {
    const key = visibility === "public" ? "publicTests" : "hiddenTests";
    const existing = data[key];
    const merged = existing ? `${existing}\n\n${content}` : content;
    const currentSource = data.gherkinSource;
    const newSource = currentSource && currentSource !== "repo" ? "mixed" : "repo";
    onChange({ ...data, [key]: merged, gherkinSource: newSource as TestsData["gherkinSource"] });
    toast.success(`Imported as ${visibility} tests`);
  };

  const handleUrlFetch = async () => {
    if (!urlInput.trim()) return;
    setIsFetchingUrl(true);
    setUrlError(null);
    setUrlPreview(null);

    try {
      const result = await fetchGherkinFromUrl({ url: urlInput.trim() });
      if (result.valid) {
        setUrlPreview(result.content);
      } else {
        setUrlError(
          `Invalid Gherkin: ${result.errors.map((e: { message: string }) => e.message).join(", ")}`
        );
      }
    } catch (err) {
      setUrlError(err instanceof Error ? err.message : "Failed to fetch URL");
    } finally {
      setIsFetchingUrl(false);
    }
  };

  const handleUrlImport = (visibility: "public" | "hidden") => {
    if (!urlPreview) return;
    const key = visibility === "public" ? "publicTests" : "hiddenTests";
    const existing = data[key];
    const merged = existing ? `${existing}\n\n${urlPreview}` : urlPreview;
    const currentSource = data.gherkinSource;
    const newSource = currentSource && currentSource !== "url" ? "mixed" : "url";
    onChange({ ...data, [key]: merged, gherkinSource: newSource as TestsData["gherkinSource"] });
    setUrlPreview(null);
    setUrlInput("");
    toast.success(`Imported as ${visibility} tests`);
  };

  const handleManualChange = (key: "publicTests" | "hiddenTests", value: string) => {
    const currentSource = data.gherkinSource;
    const newSource = currentSource && currentSource !== "manual" ? "mixed" : "manual";
    onChange({ ...data, [key]: value, gherkinSource: newSource as TestsData["gherkinSource"] });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm">
          These checks are optional. Add them now if you already know the pass/fail criteria, or leave
          this step blank and use AI-generated checks on the review step.
        </p>
        <p className="text-sm text-muted-foreground">
          Public checks are shown to solvers. Hidden checks stay private and help catch edge cases.
        </p>
      </div>

      <Tabs defaultValue="write">
        <TabsList className={`grid w-full ${canImportFromRepo ? "grid-cols-3" : "grid-cols-2"}`}>
          <TabsTrigger value="write">Write manually</TabsTrigger>
          {canImportFromRepo ? <TabsTrigger value="repo">Import from repo</TabsTrigger> : null}
          <TabsTrigger value="url">Import from link</TabsTrigger>
        </TabsList>

        <TabsContent value="write" className="space-y-6 pt-4">
          <div className="space-y-2">
            <Label>Public success checks (shown to solvers)</Label>
            <p className="text-sm text-muted-foreground">
              Write plain-language Gherkin scenarios that explain what should happen when the work is done.
            </p>
            <GherkinEditor
              value={data.publicTests}
              onChange={(v) => handleManualChange("publicTests", v)}
            />
          </div>

          <div className="space-y-2">
            <Label>Hidden success checks (private)</Label>
            <p className="text-sm text-muted-foreground">
              Keep these for edge cases, abuse prevention, or anything you do not want to reveal before
              submission.
            </p>
            <GherkinEditor
              value={data.hiddenTests}
              onChange={(v) => handleManualChange("hiddenTests", v)}
              placeholder="Feature: Hidden edge cases&#10;&#10;  Scenario: Edge case&#10;    Given ..."
            />
          </div>
        </TabsContent>

        {canImportFromRepo ? (
          <TabsContent value="repo" className="pt-4">
            <FeatureFilePicker
              featureFiles={detectedFeatures ?? []}
              onImport={handleRepoImport}
            />
          </TabsContent>
        ) : null}

        <TabsContent value="url" className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label htmlFor="gherkin-url">Link to a .feature file</Label>
            <p className="text-sm text-muted-foreground">
              Paste a direct link to a raw Gherkin file, such as a GitHub Raw URL.
            </p>
            <div className="flex gap-2">
              <Input
                id="gherkin-url"
                placeholder="https://raw.githubusercontent.com/..."
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
              />
              <Button
                variant="outline"
                onClick={handleUrlFetch}
                disabled={isFetchingUrl || !urlInput.trim()}
              >
                {isFetchingUrl ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Preview file"
                )}
              </Button>
            </div>
            {urlError && (
              <p className="text-sm text-destructive">{urlError}</p>
            )}
          </div>
          {urlPreview && (
            <div className="space-y-2">
              <Label>Preview</Label>
              <div className="max-h-64 overflow-y-auto rounded-md border p-3">
                <pre className="text-sm whitespace-pre-wrap">{urlPreview}</pre>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleUrlImport("public")}
                >
                  Add as public checks
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleUrlImport("hidden")}
                >
                  Add as hidden checks
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
