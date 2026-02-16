"use client";

import { useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { Id } from "../../../../../../convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChatInterface } from "@/components/bounties/conversation/chat-interface";
import { QuestionCard } from "@/components/bounties/conversation/question-card";
import { GherkinReview } from "@/components/bounties/conversation/gherkin-review";
import { TddReview } from "@/components/bounties/conversation/tdd-review";
import { ScenarioSummaryReview } from "@/components/bounties/conversation/scenario-summary-review";
import { TddReviewEditable } from "@/components/bounties/conversation/tdd-review-editable";
import { RepoStatusBadge } from "@/components/bounties/repo-status-badge";
import { RepoMapViewer } from "@/components/bounties/repo-map-viewer";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Loader2, Sparkles, ArrowLeft, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

export default function GeneratePage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const bountyId = searchParams.get("bountyId") as Id<"bounties"> | null;

  const [isStarting, setIsStarting] = useState(false);
  const [isClarifying, setIsClarifying] = useState(false);
  const [isGeneratingTDD, setIsGeneratingTDD] = useState(false);
  const [clarificationRound, setClarificationRound] = useState(0);

  const bounty = useQuery(
    api.bounties.getById,
    bountyId ? { bountyId } : "skip"
  );
  const repoConnection = useQuery(
    api.repoConnections.getByBountyId,
    bountyId ? { bountyId } : "skip"
  );
  const conversation = useQuery(
    api.conversations.getByBountyId,
    bountyId ? { bountyId } : "skip"
  );
  const generatedTests = useQuery(
    api.generatedTests.getByBountyId,
    bountyId ? { bountyId } : "skip"
  );
  const repoMap = useQuery(
    api.repoMaps.getByBountyId,
    bountyId ? { bountyId } : "skip"
  );

  const createConversation = useMutation(api.conversations.create);
  const startPipeline = useAction(api.orchestrator.startGenerationPipeline);
  const continueWithClarification = useAction(
    api.orchestrator.continueWithClarification
  );
  const generateBDDDirect = useAction(api.orchestrator.generateBDDDirect);
  const generateTDD = useAction(api.orchestrator.generateTDDFromBDD);
  const publishTests = useMutation(api.generatedTests.publish);
  const updateGherkin = useMutation(api.generatedTests.updateGherkin);
  const approveTests = useMutation(api.generatedTests.approve);
  const updateStepDefs = useMutation(
    api.generatedTests.updateStepDefinitionsPublic
  );
  const { isTechnical } = useCurrentUser();

  if (!bountyId) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">
          Missing bountyId parameter. Return to{" "}
          <Link href="/bounties/new" className="text-primary underline">
            bounty creation
          </Link>
          .
        </p>
      </div>
    );
  }

  if (bounty === undefined) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!bounty) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Bounty not found.</p>
      </div>
    );
  }

  const handleStartGeneration = async () => {
    setIsStarting(true);
    try {
      let convId = conversation?._id;

      if (!convId) {
        convId = await createConversation({ bountyId });
      }

      await startPipeline({ bountyId, conversationId: convId });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to start generation"
      );
    } finally {
      setIsStarting(false);
    }
  };

  const handleSubmitAnswers = async (answers: string) => {
    if (!conversation) return;
    setIsClarifying(true);
    try {
      await continueWithClarification({
        bountyId,
        conversationId: conversation._id,
        userAnswer: answers,
        clarificationRound: clarificationRound + 1,
      });
      setClarificationRound((r) => r + 1);
    } catch (error) {
      toast.error("Failed to process answers");
    } finally {
      setIsClarifying(false);
    }
  };

  const handleSkipToGenerate = async () => {
    if (!conversation) return;
    setIsStarting(true);
    try {
      await generateBDDDirect({
        bountyId,
        conversationId: conversation._id,
      });
    } catch (error) {
      toast.error("Failed to generate tests");
    } finally {
      setIsStarting(false);
    }
  };

  const handleGenerateTDD = async () => {
    if (!conversation || !generatedTests) return;
    setIsGeneratingTDD(true);
    try {
      await generateTDD({
        bountyId,
        conversationId: conversation._id,
        generatedTestId: generatedTests._id,
        primaryLanguage:
          repoConnection?.languages?.[0] || "typescript",
      });
    } catch (error) {
      toast.error("Failed to generate step definitions");
    } finally {
      setIsGeneratingTDD(false);
    }
  };

  const handleEditGherkin = async (
    type: "public" | "hidden",
    content: string
  ) => {
    if (!generatedTests) return;
    try {
      await updateGherkin({
        generatedTestId: generatedTests._id,
        ...(type === "public"
          ? { gherkinPublic: content }
          : { gherkinHidden: content }),
      });
      toast.success("Gherkin updated");
    } catch (error) {
      toast.error("Failed to update");
    }
  };

  const handlePublish = async () => {
    if (!generatedTests) return;
    try {
      await publishTests({ generatedTestId: generatedTests._id });
      toast.success("Tests published!");
      router.push(`/bounties/${bountyId}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to publish"
      );
    }
  };

  const handleApprove = async () => {
    if (!generatedTests) return;
    try {
      await approveTests({ generatedTestId: generatedTests._id });
      toast.success("Tests approved");
    } catch (error) {
      toast.error("Failed to approve tests");
    }
  };

  const handleEditStepDefinitions = async (stepDefinitions: string) => {
    if (!generatedTests) return;
    try {
      await updateStepDefs({
        generatedTestId: generatedTests._id,
        stepDefinitions,
      });
      toast.success("Step definitions updated");
    } catch (error) {
      toast.error("Failed to update step definitions");
    }
  };

  // Parse questions from the latest assistant message
  const questions = getLatestQuestions(conversation?.messages || []);

  const isProcessing =
    conversation?.status === "generating_bdd" ||
    conversation?.status === "generating_tdd";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href={`/bounties/${bountyId}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            AI Test Generation
          </h1>
          <p className="text-sm text-muted-foreground">{bounty.title}</p>
        </div>
      </div>

      {/* Repo Status */}
      {repoConnection && (
        <div className="flex items-center gap-4">
          <RepoStatusBadge
            status={repoConnection.status as any}
            totalFiles={repoConnection.totalFiles}
            totalSymbols={repoConnection.totalSymbols}
          />
          {repoMap && <RepoMapViewer repoMapText={repoMap.repoMapText} />}
        </div>
      )}

      {/* Bounty Description Summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Bounty Description</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {bounty.description.slice(0, 500)}
            {bounty.description.length > 500 ? "..." : ""}
          </p>
        </CardContent>
      </Card>

      {/* Start Generation */}
      {!conversation && (
        <Card>
          <CardContent className="py-8 text-center">
            <Sparkles className="h-8 w-8 mx-auto mb-4 text-muted-foreground" />
            <p className="text-sm text-muted-foreground mb-4">
              Generate comprehensive BDD test specifications from your bounty
              description using AI.
            </p>
            <Button
              onClick={handleStartGeneration}
              disabled={isStarting}
              size="lg"
            >
              {isStarting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Analyzing Requirements...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Start AI Generation
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Conversation Messages */}
      {conversation && conversation.messages.length > 0 && (
        <ChatInterface messages={conversation.messages} />
      )}

      {/* Clarification Questions */}
      {conversation?.status === "clarifying" && questions.length > 0 && (
        <QuestionCard
          questions={questions}
          onSubmitAnswers={handleSubmitAnswers}
          isSubmitting={isClarifying}
        />
      )}

      {/* Processing indicator */}
      {isProcessing && (
        <Card>
          <CardContent className="py-6 text-center">
            <Loader2 className="h-6 w-6 mx-auto mb-3 animate-spin" />
            <p className="text-sm text-muted-foreground">
              {conversation.status === "generating_bdd"
                ? "Generating Gherkin specifications..."
                : "Generating step definitions..."}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Gherkin Review — Technical: full GherkinReview, Non-technical: ScenarioSummaryReview */}
      {generatedTests &&
        (generatedTests.gherkinPublic || generatedTests.gherkinHidden) &&
        (isTechnical ? (
          <GherkinReview
            gherkinPublic={generatedTests.gherkinPublic}
            gherkinHidden={generatedTests.gherkinHidden}
            onEdit={handleEditGherkin}
            onApprove={handleGenerateTDD}
            isEditable={generatedTests.status === "draft"}
          />
        ) : (
          <ScenarioSummaryReview
            gherkinPublic={generatedTests.gherkinPublic}
            gherkinHidden={generatedTests.gherkinHidden}
            onContinue={handleGenerateTDD}
          />
        ))}

      {/* TDD Review — Technical: editable, Non-technical: hidden */}
      {isTechnical &&
        generatedTests &&
        generatedTests.stepDefinitions && (
          <TddReviewEditable
            stepDefinitions={generatedTests.stepDefinitions}
            framework={generatedTests.testFramework}
            language={generatedTests.testLanguage}
            isEditable={generatedTests.status !== "published"}
            onSave={handleEditStepDefinitions}
          />
        )}

      {/* Generate TDD / Approve / Publish Actions */}
      {generatedTests && conversation?.status === "review" && (
        <div className="flex justify-end gap-3">
          {!generatedTests.stepDefinitions && (
            <Button
              onClick={handleGenerateTDD}
              disabled={isGeneratingTDD}
            >
              {isGeneratingTDD ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generating Step Definitions...
                </>
              ) : (
                "Generate Step Definitions"
              )}
            </Button>
          )}

          {generatedTests.stepDefinitions && isTechnical && generatedTests.status === "draft" && (
            <Button variant="outline" onClick={handleApprove} className="gap-1">
              <ShieldCheck className="h-4 w-4" />
              Approve All Tests
            </Button>
          )}

          {generatedTests.stepDefinitions && (
            <Button
              onClick={handlePublish}
              disabled={generatedTests.status !== "approved"}
            >
              Publish Tests
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function getLatestQuestions(
  messages: Array<{ role: string; content: string }>
): Array<{ question: string; reason: string; options?: string[] }> {
  // Find the latest assistant message with questions
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      try {
        const parsed = JSON.parse(messages[i].content);
        if (parsed.ready === false && Array.isArray(parsed.questions)) {
          return parsed.questions;
        }
      } catch {
        continue;
      }
    }
  }
  return [];
}
