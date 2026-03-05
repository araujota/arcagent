"use client";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { GherkinDisplay } from "@/components/shared/gherkin-editor";
import { BountyTosModal } from "@/components/legal/bounty-tos-modal";
import { SCOPE_CERTIFICATION_TEXT } from "@/lib/legal/bounty-creation-tos";
import { RepoContextFilesSummary } from "@/components/repos/repo-context-files-summary";
import type { BasicsData } from "./step-basics";
import type { TestsData } from "./step-tests";
import type { ConfigData } from "./step-config";

interface StepReviewProps {
  basics: BasicsData;
  tests: TestsData;
  config: ConfigData;
  isCertified: boolean;
  onCertificationChange: (certified: boolean) => void;
}

export function StepReview({ basics, tests, config, isCertified, onCertificationChange }: StepReviewProps) {
  const tags = config.tags
    ? config.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-1">
          Title
        </h3>
        <p className="text-lg font-semibold">{basics.title || "Untitled"}</p>
      </div>

      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-1">
          Description
        </h3>
        <p className="text-sm">{basics.description || "No description"}</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-1">
            Reward
          </h3>
          <p className="text-lg font-semibold">
            {basics.reward} {basics.rewardCurrency}
          </p>
        </div>
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-1">
            Payment Method
          </h3>
          <p className="text-sm capitalize">{config.paymentMethod}</p>
          {config.paymentMethod === "stripe" && (
            <p className="text-xs text-muted-foreground mt-1">
              Stripe bounties are created as drafts first. After save, fund escrow and then publish.
            </p>
          )}
        </div>
      </div>

      {config.deadline && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-1">
            Deadline
          </h3>
          <p className="text-sm">
            {new Date(config.deadline).toLocaleDateString()}
          </p>
        </div>
      )}

      {config.repositoryUrl && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-1">
            Repository
          </h3>
          <p className="text-sm font-mono">{config.repositoryUrl}</p>
        </div>
      )}

      {config.repositoryUrl && (
        <RepoContextFilesSummary repositoryUrl={config.repositoryUrl} />
      )}

      {tags.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-1">
            Tags
          </h3>
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {config.requiredTier && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-1">
            Required Agent Tier
          </h3>
          <p className="text-sm font-medium">
            {config.requiredTier} or above
          </p>
          {config.requiredTier === "S" && (
            <p className="text-xs text-muted-foreground mt-1">
              S-Tier bounties require a minimum $150 reward to attract elite agents.
            </p>
          )}
        </div>
      )}

      <Separator />

      {tests.publicTests && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            Public Tests
          </h3>
          <GherkinDisplay content={tests.publicTests} />
        </div>
      )}

      {tests.hiddenTests && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            Hidden Tests
          </h3>
          <GherkinDisplay content={tests.hiddenTests} />
        </div>
      )}

      {!tests.publicTests && !tests.hiddenTests && (
        <p className="text-sm text-muted-foreground italic">
          No test suites defined. You can add them later.
        </p>
      )}

      <Separator />

      {/* Scope Certification */}
      <div className="rounded-md border p-4 space-y-3">
        <h3 className="text-sm font-semibold">Scope Certification</h3>
        <div className="flex items-start gap-3">
          <Checkbox
            id="tos-certification"
            checked={isCertified}
            onCheckedChange={(checked) => onCertificationChange(checked === true)}
          />
          <label
            htmlFor="tos-certification"
            className="text-sm leading-relaxed text-muted-foreground cursor-pointer"
          >
            {SCOPE_CERTIFICATION_TEXT.replace(
              "Bounty Creation Terms of Service.",
              ""
            )}
            <BountyTosModal>
              <button
                type="button"
                className="text-primary underline underline-offset-2 hover:text-primary/80"
              >
                Bounty Creation Terms of Service
              </button>
            </BountyTosModal>
            .
          </label>
        </div>
      </div>
    </div>
  );
}
