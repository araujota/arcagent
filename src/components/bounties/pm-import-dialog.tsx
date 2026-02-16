"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Loader2, Import } from "lucide-react";
import { toast } from "sonner";

interface WorkItemPreview {
  externalId: string;
  provider: string;
  title: string;
  description: string;
  acceptanceCriteria?: string;
  labels: string[];
  estimate?: number;
  status: string;
  priority?: string;
  url: string;
}

interface PmImportDialogProps {
  onImport: (data: {
    title: string;
    description: string;
    tags: string[];
    pmIssueKey: string;
    pmProvider: "jira" | "linear" | "asana" | "monday";
  }) => void;
  children: React.ReactNode;
}

type Provider = "jira" | "linear" | "asana" | "monday";

const PROVIDER_LABELS: Record<Provider, string> = {
  jira: "Jira",
  linear: "Linear",
  asana: "Asana",
  monday: "Monday",
};

export function PmImportDialog({ onImport, children }: PmImportDialogProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Provider>("jira");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import from Project Tool</DialogTitle>
        </DialogHeader>
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Provider)}>
          <TabsList>
            {(["jira", "linear", "asana", "monday"] as Provider[]).map((p) => (
              <TabsTrigger key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </TabsTrigger>
            ))}
          </TabsList>
          {(["jira", "linear", "asana", "monday"] as Provider[]).map((provider) => (
            <TabsContent key={provider} value={provider} className="pt-4">
              <ProviderTab
                provider={provider}
                onImport={(data) => {
                  onImport(data);
                  setOpen(false);
                }}
              />
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ProviderTab({
  provider,
  onImport,
}: {
  provider: Provider;
  onImport: PmImportDialogProps["onImport"];
}) {
  const [domain, setDomain] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [issueKey, setIssueKey] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [preview, setPreview] = useState<WorkItemPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkItem = useAction(api.pipelines.fetchWorkItem.fetchWorkItemAction);

  const handleFetch = async () => {
    if (!apiToken.trim() || !issueKey.trim()) return;
    setIsFetching(true);
    setError(null);
    setPreview(null);

    try {
      const result = await fetchWorkItem({
        provider,
        issueKey: issueKey.trim(),
        domain: domain.trim() || undefined,
        email: email.trim() || undefined,
        apiToken: apiToken.trim(),
      });
      setPreview(result as WorkItemPreview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch issue");
    } finally {
      setIsFetching(false);
    }
  };

  const handleImport = () => {
    if (!preview) return;
    const description = preview.acceptanceCriteria
      ? `${preview.description}\n\n## Acceptance Criteria\n${preview.acceptanceCriteria}`
      : preview.description;

    onImport({
      title: preview.title,
      description,
      tags: preview.labels,
      pmIssueKey: preview.externalId,
      pmProvider: provider,
    });
    toast.success(`Imported from ${PROVIDER_LABELS[provider]}`);
  };

  const needsDomain = provider === "jira" || provider === "monday";
  const needsEmail = provider === "jira";

  return (
    <div className="space-y-4">
      {/* Connection fields */}
      {needsDomain && (
        <div className="space-y-1">
          <Label>
            {provider === "jira" ? "Jira Domain" : "Monday Account"}
          </Label>
          <Input
            placeholder={
              provider === "jira"
                ? "mycompany.atlassian.net"
                : "mycompany"
            }
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </div>
      )}
      {needsEmail && (
        <div className="space-y-1">
          <Label>Email</Label>
          <Input
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      )}
      <div className="space-y-1">
        <Label>API Token</Label>
        <Input
          type="password"
          placeholder="Enter API token"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Token is used to fetch this issue only and is not stored.
        </p>
      </div>

      {/* Issue key input */}
      <div className="space-y-1">
        <Label>Issue Key / ID</Label>
        <div className="flex gap-2">
          <Input
            placeholder={
              provider === "jira"
                ? "PROJ-123"
                : provider === "linear"
                  ? "TEAM-123"
                  : provider === "asana"
                    ? "1234567890"
                    : "1234567890"
            }
            value={issueKey}
            onChange={(e) => setIssueKey(e.target.value)}
          />
          <Button
            onClick={handleFetch}
            disabled={isFetching || !apiToken.trim() || !issueKey.trim()}
          >
            {isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Fetch"
            )}
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Preview */}
      {preview && (
        <div className="rounded-md border p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-sm">{preview.title}</h4>
            <Badge variant="secondary">{preview.status}</Badge>
          </div>
          <p className="text-sm text-muted-foreground line-clamp-4">
            {preview.description || "No description"}
          </p>
          {preview.labels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {preview.labels.map((label) => (
                <Badge key={label} variant="outline" className="text-xs">
                  {label}
                </Badge>
              ))}
            </div>
          )}
          {preview.estimate && (
            <p className="text-xs text-muted-foreground">
              Estimate: {preview.estimate} points
            </p>
          )}
          <Button size="sm" onClick={handleImport} className="mt-2">
            <Import className="h-4 w-4 mr-2" />
            Import to Bounty
          </Button>
        </div>
      )}
    </div>
  );
}
