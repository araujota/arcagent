"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { Id } from "../../../../../../convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RepoStatusBadge } from "@/components/bounties/repo-status-badge";
import { RepoMapViewer } from "@/components/bounties/repo-map-viewer";
import { RequirementsReview } from "@/components/bounties/conversation/requirements-review";
import { GherkinReview } from "@/components/bounties/conversation/gherkin-review";
import { NativeTestFilesReview } from "@/components/bounties/conversation/native-test-files-review";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

const CREATION_STEPS = [
  { key: "requirements", label: "Requirements" },
  { key: "tests", label: "Tests" },
  { key: "publish", label: "Publish" },
] as const;

function stageIndex(stage?: string | null): number {
  if (stage === "done") return 2;
  if (stage === "publish") return 2;
  if (stage === "tests") return 1;
  return 0;
}

export default function GeneratePage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const bountyId = searchParams.get("bountyId") as Id<"bounties"> | null;
  const autoStarted = useRef(false);

  const [isStarting, setIsStarting] = useState(false);
  const [isSavingRequirements, setIsSavingRequirements] = useState(false);
  const [isApprovingRequirements, setIsApprovingRequirements] = useState(false);
  const [isSavingNativeTests, setIsSavingNativeTests] = useState(false);
  const [isApprovingTests, setIsApprovingTests] = useState(false);

  const bounty = useQuery(api.bounties.getById, bountyId ? { bountyId } : "skip");
  const repoConnection = useQuery(
    api.repoConnections.getByBountyId,
    bountyId ? { bountyId } : "skip",
  );
  const conversation = useQuery(
    api.conversations.getByBountyId,
    bountyId ? { bountyId } : "skip",
  );
  const generatedRequirements = useQuery(
    api.generatedRequirements.getByBountyId,
    bountyId ? { bountyId } : "skip",
  );
  const generatedTests = useQuery(
    api.generatedTests.getByBountyId,
    bountyId ? { bountyId } : "skip",
  );
  const repoMap = useQuery(api.repoMaps.getByBountyId, bountyId ? { bountyId } : "skip");

  const createConversation = useMutation(api.conversations.create);
  const retryIndexing = useMutation(api.repoConnections.retryIndexing);
  const updateRequirementDraft = useMutation(api.generatedRequirements.updateDraft);
  const updateGherkin = useMutation(api.generatedTests.updateGherkin);
  const updateNativeTestFiles = useMutation(api.generatedTests.updateNativeTestFiles);

  const startPipeline = useAction(api.orchestrator.startGenerationPipeline);
  const regenerateRequirements = useAction(api.orchestrator.regenerateRequirements);
  const approveRequirementsAndGenerateTests = useAction(
    api.orchestrator.approveRequirementsAndGenerateTests,
  );
  const regenerateTests = useAction(api.orchestrator.regenerateTestsFromApprovedRequirements);
  const validateAndApproveGeneratedTests = useAction(
    api.orchestrator.validateAndApproveGeneratedTests,
  );

  useEffect(() => {
    if (!bountyId || !bounty || autoStarted.current) return;
    if (generatedRequirements || repoConnection?.status === "failed") return;

    autoStarted.current = true;
    setIsStarting(true);

    void (async () => {
      try {
        let conversationId = conversation?._id;
        if (!conversationId) {
          conversationId = await createConversation({ bountyId });
        }
        await startPipeline({ bountyId, conversationId });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to start staged generation",
        );
        autoStarted.current = false;
      } finally {
        setIsStarting(false);
      }
    })();
  }, [
    bounty,
    bountyId,
    conversation,
    createConversation,
    generatedRequirements,
    repoConnection?.status,
    startPipeline,
  ]);

  if (!bountyId) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        Missing `bountyId`. Return to <Link href="/bounties/new" className="underline">bounty creation</Link>.
      </div>
    );
  }

  if (bounty === undefined) {
    return (
      <div className="max-w-5xl mx-auto space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!bounty) {
    return <div className="py-12 text-center text-muted-foreground">Bounty not found.</div>;
  }

  const currentStage = stageIndex(bounty.creationStage);
  const nativePublic = generatedTests?.nativeTestFilesPublic || generatedTests?.stepDefinitionsPublic || "";
  const nativeHidden = generatedTests?.nativeTestFilesHidden || generatedTests?.stepDefinitionsHidden || "";

  return (
    <div className="max-w-5xl mx-auto space-y-6">
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
            AI-Assisted Bounty Draft
          </h1>
          <p className="text-sm text-muted-foreground">{bounty.title}</p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
        {CREATION_STEPS.map((step, index) => (
          <div key={step.key} className="flex items-center gap-3 flex-1">
            <div
              className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-medium ${
                index <= currentStage
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {index + 1}
            </div>
            <span className="text-sm font-medium">{step.label}</span>
          </div>
        ))}
      </div>

      {repoConnection ? (
        <div className="flex items-center gap-4">
          <RepoStatusBadge
            status={repoConnection.status as any}
            totalFiles={repoConnection.totalFiles}
            totalSymbols={repoConnection.totalSymbols}
          />
          {repoMap ? <RepoMapViewer repoMapText={repoMap.repoMapText} /> : null}
        </div>
      ) : null}

      {!generatedRequirements ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Screen 1: Intake + Enhanced Requirements</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {repoConnection?.status === "failed" ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Repository indexing failed. You can retry indexing or continue without repo grounding.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={async () => {
                      if (!repoConnection?._id) return;
                      await retryIndexing({ repoConnectionId: repoConnection._id });
                      autoStarted.current = false;
                      toast.success("Retrying repository indexing");
                    }}
                  >
                    Retry indexing
                  </Button>
                  <Button
                    onClick={async () => {
                      if (!conversation?._id) return;
                      setIsStarting(true);
                      try {
                        await regenerateRequirements({
                          bountyId,
                          conversationId: conversation._id,
                        });
                      } finally {
                        setIsStarting(false);
                      }
                    }}
                    disabled={!conversation || isStarting}
                  >
                    Continue without repo grounding
                  </Button>
                </div>
              </>
            ) : (
              <div className="py-8 text-center">
                <Loader2 className="h-6 w-6 animate-spin mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">
                  {repoConnection && repoConnection.status !== "ready"
                    ? "Indexing the repository before requirements generation..."
                    : "Generating enhanced requirements draft..."}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <RequirementsReview
          requirementsMarkdown={generatedRequirements.requirementsMarkdown}
          acceptanceCriteria={generatedRequirements.acceptanceCriteria}
          openQuestions={generatedRequirements.openQuestions}
          citationsJson={generatedRequirements.citationsJson}
          reviewScoreJson={generatedRequirements.reviewScoreJson}
          isSaving={isSavingRequirements}
          isApproving={isApprovingRequirements}
          onSave={async (markdown) => {
            setIsSavingRequirements(true);
            try {
              await updateRequirementDraft({
                generatedRequirementId: generatedRequirements._id,
                requirementsMarkdown: markdown,
              });
              toast.success("Requirements draft updated");
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "Failed to save requirements");
            } finally {
              setIsSavingRequirements(false);
            }
          }}
          onRegenerate={async (currentDraft) => {
            if (!conversation) return;
            setIsStarting(true);
            try {
              await regenerateRequirements({
                bountyId,
                conversationId: conversation._id,
                currentDraft,
              });
              toast.success("Requirements regenerated");
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "Failed to regenerate requirements");
            } finally {
              setIsStarting(false);
            }
          }}
          onApprove={async () => {
            if (!conversation) return;
            setIsApprovingRequirements(true);
            try {
              await approveRequirementsAndGenerateTests({
                bountyId,
                conversationId: conversation._id,
                generatedRequirementId: generatedRequirements._id,
              });
              toast.success("Requirements approved. Generating tests...");
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "Failed to approve requirements");
            } finally {
              setIsApprovingRequirements(false);
            }
          }}
        />
      )}

      {generatedTests ? (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Screen 2: Review Generated Tests</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <GherkinReview
                gherkinPublic={generatedTests.gherkinPublic}
                gherkinHidden={generatedTests.gherkinHidden}
                isEditable={generatedTests.status !== "published"}
                onEdit={async (type, content) => {
                  if (!generatedTests) return;
                  try {
                    await updateGherkin({
                      generatedTestId: generatedTests._id,
                      ...(type === "public"
                        ? { gherkinPublic: content }
                        : { gherkinHidden: content }),
                    });
                    toast.success("Gherkin updated. Native tests marked stale until regenerated or edited.");
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : "Failed to update Gherkin");
                  }
                }}
              />

              <NativeTestFilesReview
                publicFiles={nativePublic}
                hiddenFiles={nativeHidden}
                isEditable={generatedTests.status !== "published"}
                onSave={async (kind, content) => {
                  setIsSavingNativeTests(true);
                  try {
                    await updateNativeTestFiles({
                      generatedTestId: generatedTests._id,
                      ...(kind === "public"
                        ? { nativeTestFilesPublic: content }
                        : { nativeTestFilesHidden: content }),
                    });
                    toast.success("Native test files updated");
                  } catch (error) {
                    toast.error(
                      error instanceof Error ? error.message : "Failed to update native test files",
                    );
                  } finally {
                    setIsSavingNativeTests(false);
                  }
                }}
              />

              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={async () => {
                    if (!conversation) return;
                    setIsStarting(true);
                    try {
                      await regenerateTests({
                        bountyId,
                        conversationId: conversation._id,
                      });
                      toast.success("Regenerating Gherkin and native test files");
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "Failed to regenerate tests");
                    } finally {
                      setIsStarting(false);
                    }
                  }}
                  disabled={!conversation || isStarting}
                >
                  Regenerate tests
                </Button>
                <Button
                  onClick={async () => {
                    if (!conversation || !generatedTests) return;
                    setIsApprovingTests(true);
                    try {
                      await validateAndApproveGeneratedTests({
                        bountyId,
                        conversationId: conversation._id,
                        generatedTestId: generatedTests._id,
                      });
                      toast.success("Tests approved");
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "Generated tests failed validation");
                    } finally {
                      setIsApprovingTests(false);
                    }
                  }}
                  disabled={isApprovingTests || isSavingNativeTests}
                >
                  {isApprovingTests ? "Validating..." : "Approve tests"}
                </Button>
              </div>
            </CardContent>
          </Card>

          {generatedTests.status === "approved" || generatedTests.status === "published" ? (
            <div className="flex justify-end">
              <Button onClick={() => router.push(`/bounties/new/finalize?bountyId=${bountyId}`)}>
                Continue to final screen
              </Button>
            </div>
          ) : null}
        </div>
      ) : generatedRequirements?.status === "approved" || bounty.creationStage === "tests" ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Loader2 className="h-6 w-6 animate-spin mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              Generating Gherkin scenarios and native test files from the approved requirements...
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
