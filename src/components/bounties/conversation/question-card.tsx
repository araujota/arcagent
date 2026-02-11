"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { HelpCircle } from "lucide-react";

interface Question {
  question: string;
  reason: string;
  options?: string[];
}

interface QuestionCardProps {
  questions: Question[];
  onSubmitAnswers: (answers: string) => void;
  isSubmitting?: boolean;
}

export function QuestionCard({
  questions,
  onSubmitAnswers,
  isSubmitting,
}: QuestionCardProps) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [freeText, setFreeText] = useState<Record<number, string>>({});

  const handleSelectOption = (questionIdx: number, option: string) => {
    setAnswers((prev) => ({ ...prev, [questionIdx]: option }));
  };

  const handleSubmit = () => {
    const formattedAnswers = questions
      .map((q, i) => {
        const answer = answers[i] || freeText[i] || "(no answer)";
        return `Q: ${q.question}\nA: ${answer}`;
      })
      .join("\n\n");

    onSubmitAnswers(formattedAnswers);
  };

  const hasAnswers = questions.some(
    (_, i) => answers[i] || freeText[i]
  );

  return (
    <Card className="border-yellow-200 bg-yellow-50/50 dark:border-yellow-900 dark:bg-yellow-950/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <HelpCircle className="h-4 w-4 text-yellow-600" />
          Clarification Needed
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {questions.map((q, i) => (
          <div key={i} className="space-y-2">
            <p className="text-sm font-medium">{q.question}</p>
            <p className="text-xs text-muted-foreground">{q.reason}</p>

            {q.options && q.options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {q.options.map((option) => (
                  <Button
                    key={option}
                    variant={answers[i] === option ? "default" : "outline"}
                    size="sm"
                    onClick={() => handleSelectOption(i, option)}
                  >
                    {option}
                  </Button>
                ))}
              </div>
            )}

            <Textarea
              placeholder="Or type a custom answer..."
              value={freeText[i] || ""}
              onChange={(e) =>
                setFreeText((prev) => ({ ...prev, [i]: e.target.value }))
              }
              className="text-sm"
              rows={2}
            />
          </div>
        ))}

        <div className="flex gap-2 pt-2">
          <Button
            onClick={handleSubmit}
            disabled={!hasAnswers || isSubmitting}
            size="sm"
          >
            {isSubmitting ? "Submitting..." : "Submit Answers"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onSubmitAnswers("Skip clarification — proceed with generation.")}
            disabled={isSubmitting}
          >
            Skip & Generate
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
