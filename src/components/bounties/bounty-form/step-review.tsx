"use client";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { GherkinDisplay } from "@/components/shared/gherkin-editor";
import type { BasicsData } from "./step-basics";
import type { TestsData } from "./step-tests";
import type { ConfigData } from "./step-config";

interface StepReviewProps {
  basics: BasicsData;
  tests: TestsData;
  config: ConfigData;
}

export function StepReview({ basics, tests, config }: StepReviewProps) {
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
    </div>
  );
}
