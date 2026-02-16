"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StarRating } from "@/components/shared/star-rating";
import { Star } from "lucide-react";

interface AgentRatingDialogProps {
  bountyId: Id<"bounties">;
  children?: React.ReactNode;
}

const DIMENSIONS = [
  { key: "codeQuality", label: "Code Quality", description: "Clean, well-structured code" },
  { key: "speed", label: "Speed", description: "How quickly the solution was delivered" },
  {
    key: "mergedWithoutChanges",
    label: "Merged Without Changes",
    description: "1 = heavy rework needed, 5 = merged as-is",
  },
  { key: "communication", label: "Communication", description: "Quality of descriptions and clarity" },
  { key: "testCoverage", label: "Test Coverage", description: "Code test quality and coverage" },
] as const;

export function AgentRatingDialog({ bountyId, children }: AgentRatingDialogProps) {
  const submitRating = useMutation(api.agentRatings.submitRating);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [ratings, setRatings] = useState<Record<string, number>>({
    codeQuality: 0,
    speed: 0,
    mergedWithoutChanges: 0,
    communication: 0,
    testCoverage: 0,
  });
  const [comment, setComment] = useState("");

  const allRated = Object.values(ratings).every((v) => v >= 1);
  const avgRating = allRated
    ? Object.values(ratings).reduce((a, b) => a + b, 0) / 5
    : 0;

  const handleSubmit = async () => {
    if (!allRated) return;
    setSubmitting(true);
    try {
      await submitRating({
        bountyId,
        codeQuality: ratings.codeQuality,
        speed: ratings.speed,
        mergedWithoutChanges: ratings.mergedWithoutChanges,
        communication: ratings.communication,
        testCoverage: ratings.testCoverage,
        comment: comment.trim() || undefined,
      });
      toast.success("Rating submitted! Agent stats will be updated.");
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to submit rating"
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children ?? (
          <Button>
            <Star className="h-4 w-4 mr-2" />
            Rate Agent
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rate the Agent</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          {DIMENSIONS.map((dim) => (
            <div key={dim.key} className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">{dim.label}</Label>
                <p className="text-xs text-muted-foreground">{dim.description}</p>
              </div>
              <StarRating
                value={ratings[dim.key]}
                onChange={(v) =>
                  setRatings((prev) => ({ ...prev, [dim.key]: v }))
                }
              />
            </div>
          ))}

          {allRated && (
            <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2">
              <span className="text-sm font-medium">Average Rating</span>
              <span className="text-sm font-semibold">
                {avgRating.toFixed(1)} / 5.0
              </span>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="comment">Comment (Optional)</Label>
            <Textarea
              id="comment"
              placeholder="Any feedback for the agent..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="min-h-[80px]"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!allRated || submitting}>
            {submitting ? "Submitting..." : "Submit Rating"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
