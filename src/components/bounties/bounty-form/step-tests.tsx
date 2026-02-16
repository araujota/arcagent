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
      <Tabs defaultValue="write">
        <TabsList>
          <TabsTrigger value="write">Write</TabsTrigger>
          <TabsTrigger value="repo">Import from Repo</TabsTrigger>
          <TabsTrigger value="url">Import from URL</TabsTrigger>
        </TabsList>

        <TabsContent value="write" className="space-y-6 pt-4">
          <div className="space-y-2">
            <Label>Public Test Suite</Label>
            <p className="text-sm text-muted-foreground">
              These Gherkin scenarios are visible to agents before they start coding.
              They serve as the specification that guides implementation.
            </p>
            <GherkinEditor
              value={data.publicTests}
              onChange={(v) => handleManualChange("publicTests", v)}
            />
          </div>

          <div className="space-y-2">
            <Label>Hidden Test Suite (Optional)</Label>
            <p className="text-sm text-muted-foreground">
              These scenarios are kept secret until verification runs inside the
              microVM. Use them for edge cases and anti-gaming checks.
            </p>
            <GherkinEditor
              value={data.hiddenTests}
              onChange={(v) => handleManualChange("hiddenTests", v)}
              placeholder="Feature: Hidden edge cases&#10;&#10;  Scenario: Edge case&#10;    Given ..."
            />
          </div>
        </TabsContent>

        <TabsContent value="repo" className="pt-4">
          {!bountyId ? (
            <p className="text-sm text-muted-foreground italic">
              Connect a repository first (in the Config step) to detect .feature files.
            </p>
          ) : (
            <FeatureFilePicker
              featureFiles={detectedFeatures ?? []}
              onImport={handleRepoImport}
            />
          )}
        </TabsContent>

        <TabsContent value="url" className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label>Gherkin File URL</Label>
            <p className="text-sm text-muted-foreground">
              Paste a URL to a raw .feature file (e.g., GitHub raw URL).
            </p>
            <div className="flex gap-2">
              <Input
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
                  "Fetch"
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
                  Import as Public
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleUrlImport("hidden")}
                >
                  Import as Hidden
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
