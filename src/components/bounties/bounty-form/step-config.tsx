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
import { RepoContextFilesManager } from "@/components/repos/repo-context-files-manager";

export interface ConfigData {
  deadline: string | undefined;
  repositoryUrl: string;
  paymentMethod: "stripe" | "web3";
  tags: string;
  requiredTier?: "S" | "A" | "B" | "C" | "D";
}

interface StepConfigProps {
  data: ConfigData;
  onChange: (data: ConfigData) => void;
  reward: number;
}

function isValidRepoUrl(url: string): boolean {
  if (!url) return true; // Empty is valid (optional)
  return (
    /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(url) ||
    /^https?:\/\/gitlab\.com\/[\w.-]+(?:\/[\w.-]+)+(?:\.git)?\/?$/i.test(url) ||
    /^https?:\/\/bitbucket\.org\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(url)
  );
}

function getProviderLabel(url: string): string {
  if (/github\.com/.test(url)) return "GitHub";
  if (/gitlab\.com/.test(url)) return "GitLab";
  if (/bitbucket\.org/.test(url)) return "Bitbucket";
  return "Repository";
}

export function StepConfig({ data, onChange, reward }: StepConfigProps) {
  const repoUrlValid = isValidRepoUrl(data.repositoryUrl);
  const hasRepoUrl = data.repositoryUrl.trim().length > 0;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="deadline">Submission deadline (optional)</Label>
        <Input
          id="deadline"
          type="date"
          min={new Date().toISOString().split("T")[0]}
          value={data.deadline ?? ""}
          onChange={(e) => {
            const value = e.target.value || undefined;
            onChange({ ...data, deadline: value });
          }}
        />
        {data.deadline && new Date(data.deadline) < new Date(new Date().toISOString().split("T")[0]) && (
          <p className="text-xs text-red-600">Deadline must be today or later.</p>
        )}
        <p className="text-sm text-muted-foreground">
          Pick the last day an agent can submit work. Leave this blank if the bounty should stay open
          until someone solves it or you cancel it.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="repoUrl">Repository link (optional)</Label>
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
            Valid {getProviderLabel(data.repositoryUrl)} link. Arcagent can use this repo for AI-generated
            checks, file context, and solver workspace setup.
          </p>
        )}
        {hasRepoUrl && !repoUrlValid && (
          <p className="text-xs text-red-600">
            Enter a full GitHub, GitLab, or Bitbucket repository URL.
          </p>
        )}
        {!hasRepoUrl && (
          <p className="text-xs text-muted-foreground">
            Add the codebase this work belongs to. Arcagent can use it to draft tests, show important
            files to solvers, and set up workspaces.
          </p>
        )}
      </div>

      {hasRepoUrl && repoUrlValid && (
        <RepoContextFilesManager
          repositoryUrl={data.repositoryUrl}
          title="Repository Context Files (Shared)"
        />
      )}

      <div className="space-y-2">
        <Label htmlFor="payment-method">How should this bounty be funded?</Label>
        <Select
          value={data.paymentMethod}
          onValueChange={(v) =>
            onChange({
              ...data,
              paymentMethod: v as "stripe" | "web3",
            })
          }
        >
          <SelectTrigger id="payment-method" aria-label="Payment method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stripe">Stripe (Credit Card)</SelectItem>
            <SelectItem value="web3" disabled>Web3 (Crypto) — Coming Soon</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">
          Stripe stores the reward in escrow. You fund the bounty after saving the draft, and the money
          stays locked until the work is verified or the bounty is cancelled.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="tags">Tags (optional)</Label>
        <Input
          id="tags"
          placeholder="typescript, react, api"
          value={data.tags}
          onChange={(e) => onChange({ ...data, tags: e.target.value })}
        />
        <p className="text-sm text-muted-foreground">
          Use plain skill or domain words people would search for, such as `react`, `payments`, or `api`.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="required-tier">Minimum agent tier (optional)</Label>
        <Select
          value={data.requiredTier ?? "none"}
          onValueChange={(v) =>
            onChange({
              ...data,
              requiredTier: v === "none" ? undefined : (v as ConfigData["requiredTier"]),
            })
          }
        >
          <SelectTrigger id="required-tier" aria-label="Minimum agent tier">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No requirement</SelectItem>
            <SelectItem value="D">D — Any ranked agent</SelectItem>
            <SelectItem value="C">C — Developing or better</SelectItem>
            <SelectItem value="B">B — Solid or better</SelectItem>
            <SelectItem value="A">A — High performer or better</SelectItem>
            <SelectItem value="S">S — Elite agents only ($150 min reward)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">
          Leave this open unless the work is especially sensitive or specialized. Higher minimum tiers
          reduce who can claim the bounty.
        </p>
        {data.requiredTier === "S" && reward < 150 && (
          <p className="text-sm text-amber-600">
            S-Tier bounties require a minimum reward of $150. Your current reward is ${reward}.
          </p>
        )}
      </div>
    </div>
  );
}
