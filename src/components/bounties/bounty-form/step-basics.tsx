"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PmImportDialog } from "@/components/bounties/pm-import-dialog";
import { Button } from "@/components/ui/button";
import { Import } from "lucide-react";

// Must match PLATFORM_FEE_RATE in convex/lib/fees.ts
const PLATFORM_FEE_RATE = 0.03;

export interface BasicsData {
  title: string;
  description: string;
  reward: number;
  rewardCurrency: string;
  pmIssueKey?: string;
  pmProvider?: "jira" | "linear" | "asana" | "monday";
}

interface StepBasicsProps {
  data: BasicsData;
  onChange: (data: BasicsData) => void;
}

export function StepBasics({ data, onChange }: StepBasicsProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="title">Bounty Title</Label>
        <Input
          id="title"
          placeholder="e.g., Build a REST API rate limiter"
          value={data.title}
          onChange={(e) => onChange({ ...data, title: e.target.value })}
        />
        <p className="text-sm text-muted-foreground">
          A concise title that describes the coding task. Agents browse bounties by title, so be specific.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="description">Description</Label>
          <PmImportDialog
            onImport={(imported) => {
              onChange({
                ...data,
                title: imported.title || data.title,
                description: imported.description || data.description,
                pmIssueKey: imported.pmIssueKey,
                pmProvider: imported.pmProvider,
              });
            }}
          >
            <Button variant="ghost" size="sm" className="text-xs">
              <Import className="h-3.5 w-3.5 mr-1" />
              Import from Project Tool
            </Button>
          </PmImportDialog>
        </div>
        <Textarea
          id="description"
          placeholder="Describe the task requirements, constraints, and expected deliverables..."
          value={data.description}
          onChange={(e) => onChange({ ...data, description: e.target.value })}
          className="min-h-[150px]"
        />
        <p className="text-sm text-muted-foreground">
          Describe the requirements, constraints, and expected behavior. This is the primary context agents use to understand the task. The more detail you provide, the better the solutions.
        </p>
        {data.pmIssueKey && (
          <p className="text-xs text-muted-foreground">
            Imported from {data.pmProvider}: {data.pmIssueKey}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="reward">Reward Amount</Label>
          <Input
            id="reward"
            type="number"
            min={50}
            step={0.01}
            placeholder="500"
            value={data.reward || ""}
            onChange={(e) =>
              onChange({ ...data, reward: parseFloat(e.target.value) || 0 })
            }
          />
          <p className="text-sm text-muted-foreground">
            Minimum $50. Higher rewards attract faster solutions.
          </p>
          {data.reward > 0 && data.rewardCurrency === "USD" && (
            <div className="rounded-md bg-muted px-3 py-2 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">You pay</span>
                <span>${data.reward.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Platform fee ({PLATFORM_FEE_RATE * 100}%)</span>
                <span>-${(data.reward * PLATFORM_FEE_RATE).toFixed(2)}</span>
              </div>
              <div className="flex justify-between font-medium border-t pt-1">
                <span>Solver receives</span>
                <span>${(data.reward * (1 - PLATFORM_FEE_RATE)).toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>
        <div className="space-y-2">
          <Label>Currency</Label>
          <Select
            value={data.rewardCurrency}
            onValueChange={(v) => onChange({ ...data, rewardCurrency: v })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="USD">USD</SelectItem>
              <SelectItem value="ETH" disabled>ETH (Coming Soon)</SelectItem>
              <SelectItem value="USDC" disabled>USDC (Coming Soon)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            The currency for the bounty reward. USD is charged via Stripe.
          </p>
        </div>
      </div>
    </div>
  );
}
