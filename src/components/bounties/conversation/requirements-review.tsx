"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

interface Criterion {
  id: string;
  text: string;
}

interface RequirementsReviewProps {
  requirementsMarkdown: string;
  acceptanceCriteria: Criterion[];
  openQuestions: string[];
  citationsJson?: string;
  reviewScoreJson?: string;
  isEditable?: boolean;
  isSaving?: boolean;
  isApproving?: boolean;
  onSave: (markdown: string) => Promise<void> | void;
  onApprove: () => Promise<void> | void;
  onRegenerate?: (currentDraft: string) => Promise<void> | void;
}

export function RequirementsReview({
  requirementsMarkdown,
  acceptanceCriteria,
  openQuestions,
  citationsJson,
  reviewScoreJson,
  isEditable = true,
  isSaving = false,
  isApproving = false,
  onSave,
  onApprove,
  onRegenerate,
}: RequirementsReviewProps) {
  const [draft, setDraft] = useState(requirementsMarkdown);
  const [isEditing, setIsEditing] = useState(false);
  const review = useMemo(() => {
    try {
      return reviewScoreJson ? JSON.parse(reviewScoreJson) : null;
    } catch {
      return null;
    }
  }, [reviewScoreJson]);
  const citationsMeta = useMemo(() => {
    try {
      return citationsJson ? JSON.parse(citationsJson) : null;
    } catch {
      return null;
    }
  }, [citationsJson]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-sm">Enhanced Requirements</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Review and edit the repo-grounded requirements before test generation starts.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {citationsMeta?.staleAfterEdit ? (
                <Badge variant="outline">Citations stale after edit</Badge>
              ) : (
                <Badge variant="secondary">Repo grounded</Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isEditing ? (
            <Textarea
              className="min-h-[420px] font-mono text-xs"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : (
            <pre className="rounded-md bg-muted p-4 text-xs whitespace-pre-wrap overflow-auto max-h-[560px]">
              {requirementsMarkdown}
            </pre>
          )}

          <div className="flex flex-wrap gap-2">
            {isEditable && !isEditing ? (
              <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                Edit
              </Button>
            ) : null}
            {isEditing ? (
              <>
                <Button
                  size="sm"
                  disabled={isSaving}
                  onClick={async () => {
                    await onSave(draft);
                    setIsEditing(false);
                  }}
                >
                  {isSaving ? "Saving..." : "Save edits"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraft(requirementsMarkdown);
                    setIsEditing(false);
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : null}
            {onRegenerate ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRegenerate(isEditing ? draft : requirementsMarkdown)}
              >
                Regenerate
              </Button>
            ) : null}
            <Button size="sm" disabled={isEditing || isApproving} onClick={() => onApprove()}>
              {isApproving ? "Approving..." : "Approve requirements"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Grounding Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Acceptance Criteria</p>
            <div className="space-y-2">
              {acceptanceCriteria.length > 0 ? (
                acceptanceCriteria.map((criterion) => (
                  <div key={criterion.id} className="rounded-md border p-2">
                    <p className="text-[11px] font-medium">{criterion.id}</p>
                    <p className="text-xs text-muted-foreground">{criterion.text}</p>
                  </div>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">No extracted criteria yet.</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Open Questions / Assumptions</p>
            {openQuestions.length > 0 ? (
              <ul className="space-y-2">
                {openQuestions.map((question, index) => (
                  <li key={index} className="rounded-md border p-2 text-xs text-muted-foreground">
                    {question}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">None.</p>
            )}
          </div>

          {review?.scores ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Review Rubric</p>
              <pre className="rounded-md bg-muted p-3 text-[11px] whitespace-pre-wrap">
                {JSON.stringify(review.scores, null, 2)}
              </pre>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
