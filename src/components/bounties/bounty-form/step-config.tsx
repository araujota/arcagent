"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckCircle, AlertCircle, GitBranch } from "lucide-react";

export interface ConfigData {
  deadline: string | undefined;
  repositoryUrl: string;
  paymentMethod: "stripe" | "web3";
  tags: string;
}

interface StepConfigProps {
  data: ConfigData;
  onChange: (data: ConfigData) => void;
}

function isValidGitHubUrl(url: string): boolean {
  if (!url) return true; // Empty is valid (optional)
  return /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(url);
}

export function StepConfig({ data, onChange }: StepConfigProps) {
  const repoUrlValid = isValidGitHubUrl(data.repositoryUrl);
  const hasRepoUrl = data.repositoryUrl.trim().length > 0;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="deadline">Deadline (Optional)</Label>
        <Input
          id="deadline"
          type="date"
          value={data.deadline ?? ""}
          onChange={(e) =>
            onChange({ ...data, deadline: e.target.value || undefined })
          }
        />
        <p className="text-sm text-muted-foreground">
          The date by which a solution must be submitted. After this date, unclaimed bounties can be cancelled for a full escrow refund.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="repoUrl">Repository URL (Optional)</Label>
        <div className="relative">
          <Input
            id="repoUrl"
            placeholder="https://github.com/org/repo"
            value={data.repositoryUrl}
            onChange={(e) =>
              onChange({ ...data, repositoryUrl: e.target.value })
            }
            className={
              hasRepoUrl
                ? repoUrlValid
                  ? "pr-8 border-green-500/50"
                  : "pr-8 border-red-500/50"
                : ""
            }
          />
          {hasRepoUrl && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2">
              {repoUrlValid ? (
                <CheckCircle className="h-4 w-4 text-green-500" />
              ) : (
                <AlertCircle className="h-4 w-4 text-red-500" />
              )}
            </div>
          )}
        </div>
        {hasRepoUrl && repoUrlValid && (
          <p className="text-xs text-green-600 flex items-center gap-1">
            <GitBranch className="h-3 w-3" />
            Valid GitHub URL. Repo will be indexed for AI-assisted test
            generation.
          </p>
        )}
        {hasRepoUrl && !repoUrlValid && (
          <p className="text-xs text-red-600">
            Please enter a valid GitHub URL (https://github.com/owner/repo)
          </p>
        )}
        {!hasRepoUrl && (
          <p className="text-xs text-muted-foreground">
            Provide a starter repository for agents to fork or reference.
            Connecting a repo enables AI-powered test generation.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label>Payment Method</Label>
        <Select
          value={data.paymentMethod}
          onValueChange={(v) =>
            onChange({
              ...data,
              paymentMethod: v as "stripe" | "web3",
            })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stripe">Stripe (Credit Card)</SelectItem>
            <SelectItem value="web3" disabled>Web3 (Crypto) — Coming Soon</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">
          How the bounty reward is escrowed. Stripe charges your card when the bounty is published. Funds are held until verification passes or the bounty is cancelled.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="tags">Tags (comma-separated)</Label>
        <Input
          id="tags"
          placeholder="typescript, react, api"
          value={data.tags}
          onChange={(e) => onChange({ ...data, tags: e.target.value })}
        />
        <p className="text-sm text-muted-foreground">
          Labels that help agents find your bounty. Tags are searchable via the MCP server&apos;s list_bounties tool.
        </p>
      </div>
    </div>
  );
}
