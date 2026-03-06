"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useMutation, useAction, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StepBasics, type BasicsData } from "./step-basics";
import { StepTests, type TestsData } from "./step-tests";
import { StepConfig, type ConfigData } from "./step-config";
import { StepReview } from "./step-review";
import { RepoStatusBadge } from "@/components/bounties/repo-status-badge";
import { useProductAnalytics } from "@/lib/analytics";
import { toast } from "sonner";
import { Sparkles, Loader2 } from "lucide-react";

const WIZARD_STORAGE_KEY = "arcagent_bounty_wizard_draft";

const STEPS = [
  {
    label: "Task",
    title: "Describe the work",
    description: "Name the outcome, explain the goal, and set the reward.",
  },
  {
    label: "Checks",
    title: "Add success checks",
    description: "Optional: write visible or hidden checks now, or generate them later.",
  },
  {
    label: "Setup",
    title: "Choose bounty settings",
    description: "Add repo, deadline, funding, and any claim restrictions.",
  },
  {
    label: "Review",
    title: "Review before publishing",
    description: "Confirm the details, accept the terms, and save or publish.",
  },
] as const;

interface GitHubPermissionStatus {
  provider: "github" | "gitlab" | "bitbucket" | null;
  appConfigured: boolean;
  hasInstallation: boolean;
  installUrl: string | null;
  installationId?: number;
}

type RepoProvider = "github" | "gitlab" | "bitbucket" | null;

function detectRepoProvider(url: string): RepoProvider {
  const trimmed = url.trim();
  if (/^https?:\/\/github\.com\//i.test(trimmed)) return "github";
  if (/^https?:\/\/gitlab\.com\//i.test(trimmed)) return "gitlab";
  if (/^https?:\/\/bitbucket\.org\//i.test(trimmed)) return "bitbucket";
  return null;
}

function normalizeTags(rawTags: string | undefined): string[] | undefined {
  if (!rawTags) return undefined;
  return [...new Set(rawTags.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function deadlineToMs(deadline: string | undefined): number | undefined {
  return deadline ? new Date(deadline).getTime() : undefined;
}

function canProceedToNextStep(
  currentStep: number,
  basics: BasicsData,
  config: ConfigData,
): boolean {
  if (currentStep === 0) {
    return !!(basics.title.trim() && basics.description.trim() && basics.reward >= 50);
  }
  if (currentStep === 1) {
    return !!basics.title.trim();
  }
  if (currentStep === 2) {
    return !(config.requiredTier === "S" && basics.reward < 150);
  }
  return false;
}

function providerDisplayName(provider: "gitlab" | "bitbucket"): string {
  return provider === "gitlab" ? "GitLab" : "Bitbucket";
}

async function ensureAiGenerationRepoReadiness(args: {
  repositoryUrl: string;
  repoProvider: RepoProvider;
  oauthRepoProvider: "gitlab" | "bitbucket" | null;
  providerConnections: Array<{ provider: string; status: string }> | undefined;
  oauthRepoConnection: { provider: string; status: string } | null;
  getGitHubPermissionStatus: (args: { repositoryUrl: string }) => Promise<unknown>;
  setGithubPermissionStatus: (status: GitHubPermissionStatus | null) => void;
}): Promise<boolean> {
  if (args.repositoryUrl && args.repoProvider === "github") {
    const permission = (await args.getGitHubPermissionStatus({
      repositoryUrl: args.repositoryUrl,
    })) as GitHubPermissionStatus;
    args.setGithubPermissionStatus(permission);
    if (permission.appConfigured && !permission.hasInstallation) {
      toast.error("Install the Arcagent GitHub App for this repository before indexing.");
      return false;
    }
  }

  if (args.repositoryUrl && args.oauthRepoProvider) {
    if (args.providerConnections === undefined) {
      toast.error("Checking repository integration status. Try again in a moment.");
      return false;
    }
    if (!args.oauthRepoConnection) {
      toast.error(
        `Connect your ${providerDisplayName(args.oauthRepoProvider)} account before indexing this repository.`,
      );
      return false;
    }
  }
  return true;
}

function buildDraftBountyInput(args: {
  basics: BasicsData;
  config: ConfigData;
}) {
  return {
    title: args.basics.title,
    description: args.basics.description,
    reward: args.basics.reward,
    rewardCurrency: args.basics.rewardCurrency,
    paymentMethod: args.config.paymentMethod,
    deadline: deadlineToMs(args.config.deadline),
    repositoryUrl: args.config.repositoryUrl || undefined,
    tags: normalizeTags(args.config.tags),
    status: "draft" as const,
    requiredTier: args.config.requiredTier,
  };
}

async function connectRepositoryForAiGeneration(args: {
  bountyId: Id<"bounties">;
  repositoryUrl: string;
  connectRepo: (args: { bountyId: Id<"bounties">; repositoryUrl: string }) => Promise<unknown>;
  setIsConnectingRepo: (value: boolean) => void;
}): Promise<void> {
  if (!args.repositoryUrl) return;
  args.setIsConnectingRepo(true);
  try {
    await args.connectRepo({
      bountyId: args.bountyId,
      repositoryUrl: args.repositoryUrl,
    });
    toast.success("Repository connected. Indexing started.");
  } catch (repoErr) {
    toast.error(
      repoErr instanceof Error
        ? `Repository error: ${repoErr.message}`
        : "Failed to connect repository. You can still generate tests."
    );
  } finally {
    args.setIsConnectingRepo(false);
  }
}

function renderStepForm(
  currentStep: number,
  args: {
    basics: BasicsData;
    tests: TestsData;
    config: ConfigData;
    isCertified: boolean;
    setBasics: (value: BasicsData) => void;
    setTests: (value: TestsData) => void;
    setConfig: (value: ConfigData) => void;
    setIsCertified: (value: boolean) => void;
  },
) {
  switch (currentStep) {
    case 0:
      return <StepBasics data={args.basics} onChange={args.setBasics} />;
    case 1:
      return <StepTests data={args.tests} onChange={args.setTests} />;
    case 2:
      return <StepConfig data={args.config} onChange={args.setConfig} reward={args.basics.reward} />;
    case 3:
      return (
        <StepReview
          basics={args.basics}
          tests={args.tests}
          config={args.config}
          isCertified={args.isCertified}
          onCertificationChange={args.setIsCertified}
        />
      );
    default:
      return null;
  }
}

function renderGithubPermissionPanel(args: {
  currentStep: number;
  repoProvider: RepoProvider;
  isCheckingGithubPermission: boolean;
  githubPermissionStatus: GitHubPermissionStatus | null;
  onCheck: () => Promise<void>;
}) {
  if (args.currentStep !== 2 || args.repoProvider !== "github") return null;
  return (
    <div className="mt-4 rounded-md border p-3 space-y-2">
      <p className="text-sm font-medium">GitHub Permission</p>
      <p className="text-xs text-muted-foreground">
        Arcagent uses a GitHub App installation token scoped to this repo for indexing,
        workspace cloning, and auto-PR publishing.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={args.onCheck}
          disabled={args.isCheckingGithubPermission}
        >
          {args.isCheckingGithubPermission ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : null}
          Check GitHub Access
        </Button>
        {args.githubPermissionStatus?.appConfigured &&
          !args.githubPermissionStatus.hasInstallation &&
          args.githubPermissionStatus.installUrl && (
            <Button asChild size="sm">
              <a
                href={args.githubPermissionStatus.installUrl}
                target="_blank"
                rel="noreferrer"
              >
                Install GitHub App
              </a>
            </Button>
          )}
      </div>
      {args.githubPermissionStatus?.appConfigured && args.githubPermissionStatus.hasInstallation && (
        <p className="text-xs text-green-700">
          Installation detected. Repo-scoped credentials will be minted automatically.
        </p>
      )}
      {args.githubPermissionStatus?.appConfigured && !args.githubPermissionStatus.hasInstallation && (
        <p className="text-xs text-amber-700">
          No GitHub App installation found for this repository yet.
        </p>
      )}
      {args.githubPermissionStatus && !args.githubPermissionStatus.appConfigured && (
        <p className="text-xs text-muted-foreground">
          GitHub App is not configured in this environment. Falling back to legacy token settings.
        </p>
      )}
    </div>
  );
}

function renderOAuthPanel(args: {
  currentStep: number;
  oauthRepoProvider: "gitlab" | "bitbucket" | null;
  oauthRepoConnection: { provider: string; status: string; accountName?: string; accountId?: string } | null;
  isStartingProviderOAuth: boolean;
  onConnect: () => Promise<void>;
  onManage: () => void;
}) {
  if (args.currentStep !== 2 || !args.oauthRepoProvider) return null;
  return (
    <div className="mt-4 rounded-md border p-3 space-y-2">
      <p className="text-sm font-medium">
        {args.oauthRepoProvider === "gitlab" ? "GitLab OAuth Access" : "Bitbucket OAuth Access"}
      </p>
      <p className="text-xs text-muted-foreground">
        Arcagent uses your connected account token for indexing, workspace cloning, and
        auto publish of review requests for this repository provider.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {args.oauthRepoConnection ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={args.onManage}
          >
            Manage Connection
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={args.onConnect}
            disabled={args.isStartingProviderOAuth}
          >
            {args.isStartingProviderOAuth ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : null}
            Connect {providerDisplayName(args.oauthRepoProvider)}
          </Button>
        )}
      </div>
      {args.oauthRepoConnection ? (
        <p className="text-xs text-green-700">
          Connected as {args.oauthRepoConnection.accountName || args.oauthRepoConnection.accountId || "account"}.
        </p>
      ) : (
        <p className="text-xs text-amber-700">
          No active {providerDisplayName(args.oauthRepoProvider)} connection found for your user.
        </p>
      )}
    </div>
  );
}

export function BountyWizard({ repoUrl }: { repoUrl?: string }) {
  const router = useRouter();
  const trackEvent = useProductAnalytics();
  const createBounty = useMutation(api.bounties.create);
  const createTestSuite = useMutation(api.testSuites.create);
  const connectRepo = useAction(api.bounties.connectRepo);
  const getGitHubPermissionStatus = useAction(api.repoConnections.getGitHubPermissionStatus);
  const startProviderOAuth = useAction(api.providerConnections.startProviderOAuth);
  const providerConnections = useQuery(api.providerConnections.listMine);
  const [currentStep, setCurrentStep] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isConnectingRepo, setIsConnectingRepo] = useState(false);
  const [isCheckingGithubPermission, setIsCheckingGithubPermission] = useState(false);
  const [isStartingProviderOAuth, setIsStartingProviderOAuth] = useState(false);
  const [githubPermissionStatus, setGithubPermissionStatus] = useState<GitHubPermissionStatus | null>(null);
  const [createdBountyId, setCreatedBountyId] = useState<Id<"bounties"> | null>(null);

  const [basics, setBasics] = useState<BasicsData>({
    title: "",
    description: "",
    reward: 0,
    rewardCurrency: "USD",
  });

  const [tests, setTests] = useState<TestsData>({
    publicTests: "",
    hiddenTests: "",
  });

  const [config, setConfig] = useState<ConfigData>({
    deadline: undefined,
    repositoryUrl: repoUrl ?? "",
    paymentMethod: "stripe",
    tags: "",
  });

  const [isCertified, setIsCertified] = useState(false);
  const repoProvider = detectRepoProvider(config.repositoryUrl);
  const oauthRepoProvider = repoProvider === "gitlab" || repoProvider === "bitbucket"
    ? repoProvider
    : null;
  const oauthRepoConnection = useMemo(() => {
    if (!oauthRepoProvider || !providerConnections) return null;
    return providerConnections.find(
      (conn) => conn.provider === oauthRepoProvider && conn.status === "active",
    ) ?? null;
  }, [oauthRepoProvider, providerConnections]);

  // Restore saved wizard state from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(WIZARD_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.basics) setBasics(parsed.basics);
        if (parsed.tests) setTests(parsed.tests);
        if (parsed.config) setConfig(parsed.config);
        if (typeof parsed.currentStep === "number") setCurrentStep(parsed.currentStep);
      }
    } catch {
      // Ignore corrupted storage
    }
  }, []);

  // Persist wizard state to localStorage on changes
  const saveWizardState = useCallback(() => {
    try {
      localStorage.setItem(
        WIZARD_STORAGE_KEY,
        JSON.stringify({ basics, tests, config, currentStep })
      );
    } catch {
      // localStorage full or unavailable
    }
  }, [basics, tests, config, currentStep]);

  useEffect(() => {
    saveWizardState();
  }, [saveWizardState]);

  useEffect(() => {
    setGithubPermissionStatus(null);
  }, [config.repositoryUrl]);

  const clearWizardState = () => {
    try { localStorage.removeItem(WIZARD_STORAGE_KEY); } catch { /* ignore */ }
  };

  // Query repo connection status if bounty was created
  const repoConnection = useQuery(
    api.repoConnections.getByBountyId,
    createdBountyId ? { bountyId: createdBountyId } : "skip"
  );

  const handleSubmit = async (asDraft: boolean) => {
    setIsSubmitting(true);
    try {
      const bountyId = await createBounty({
        title: basics.title,
        description: basics.description,
        reward: basics.reward,
        rewardCurrency: basics.rewardCurrency,
        paymentMethod: config.paymentMethod,
        deadline: deadlineToMs(config.deadline),
        repositoryUrl: config.repositoryUrl || undefined,
        tags: normalizeTags(config.tags),
        status: asDraft ? "draft" : "active",
        requiredTier: config.requiredTier,
        ...(!asDraft && {
          tosAccepted: true,
          tosAcceptedAt: Date.now(),
          tosVersion: "1.0",
        }),
      });

      if (tests.publicTests.trim()) {
        await createTestSuite({
          bountyId,
          title: "Public Test Suite",
          gherkinContent: tests.publicTests,
          visibility: "public",
        });
      }

      if (tests.hiddenTests.trim()) {
        await createTestSuite({
          bountyId,
          title: "Hidden Test Suite",
          gherkinContent: tests.hiddenTests,
          visibility: "hidden",
        });
      }

      clearWizardState();
      if (asDraft) {
        trackEvent("bounty_draft_created", {
          bountyId,
          paymentMethod: config.paymentMethod,
        });
        toast.success(
          config.paymentMethod === "stripe"
            ? "Draft saved. Next: fund escrow, then publish."
            : "Draft saved."
        );
      } else {
        trackEvent("bounty_published", { bountyId });
        toast.success("Bounty published!");
      }
      router.push(`/bounties/${bountyId}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create bounty"
      );
      console.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAIGenerate = async () => {
    setIsSubmitting(true);
    try {
      const isRepoReady = await ensureAiGenerationRepoReadiness({
        repositoryUrl: config.repositoryUrl,
        repoProvider,
        oauthRepoProvider,
        providerConnections,
        oauthRepoConnection,
        getGitHubPermissionStatus,
        setGithubPermissionStatus,
      });
      if (!isRepoReady) return;

      const bountyId = await createBounty(buildDraftBountyInput({ basics, config }));

      setCreatedBountyId(bountyId);
      await connectRepositoryForAiGeneration({
        bountyId,
        repositoryUrl: config.repositoryUrl,
        connectRepo,
        setIsConnectingRepo,
      });

      // Navigate to the AI generation page
      clearWizardState();
      router.push(`/bounties/new/generate?bountyId=${bountyId}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create bounty"
      );
      console.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCheckGithubPermission = async () => {
    if (!config.repositoryUrl || repoProvider !== "github") return;
    setIsCheckingGithubPermission(true);
    try {
      const permission = (await getGitHubPermissionStatus({
        repositoryUrl: config.repositoryUrl,
      })) as GitHubPermissionStatus;
      setGithubPermissionStatus(permission);
      if (permission.appConfigured && permission.hasInstallation) {
        toast.success("GitHub App access is configured for this repository.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to check GitHub app permissions");
    } finally {
      setIsCheckingGithubPermission(false);
    }
  };

  const handleConnectOAuthProvider = async () => {
    if (!oauthRepoProvider) return;
    setIsStartingProviderOAuth(true);
    try {
      const result = await startProviderOAuth({
        provider: oauthRepoProvider,
        returnTo: `${window.location.pathname}${window.location.search}`,
      });
      window.location.href = result.authorizeUrl;
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : `Failed to start ${oauthRepoProvider} OAuth flow`,
      );
      setIsStartingProviderOAuth(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Step indicator */}
      <div className="flex items-center justify-between mb-8">
        {STEPS.map((step, i) => (
          <div key={step.label} className="flex items-center">
            <div className="flex flex-col items-center">
              <div
                className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  i <= currentStep
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {i + 1}
              </div>
              <span className="text-xs mt-1 text-muted-foreground">{step.label}</span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`h-px w-16 sm:w-24 mx-2 ${
                  i < currentStep ? "bg-primary" : "bg-muted"
                }`}
              />
            )}
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{STEPS[currentStep].title}</CardTitle>
          <CardDescription>{STEPS[currentStep].description}</CardDescription>
        </CardHeader>
        <CardContent>
          {renderStepForm(currentStep, {
            basics,
            tests,
            config,
            isCertified,
            setBasics,
            setTests,
            setConfig,
            setIsCertified,
          })}
          {renderGithubPermissionPanel({
            currentStep,
            repoProvider,
            isCheckingGithubPermission,
            githubPermissionStatus,
            onCheck: handleCheckGithubPermission,
          })}
          {renderOAuthPanel({
            currentStep,
            oauthRepoProvider,
            oauthRepoConnection,
            isStartingProviderOAuth,
            onConnect: handleConnectOAuthProvider,
            onManage: () => router.push("/settings"),
          })}

          {/* Repo connection status */}
          {repoConnection && (
            <div className="mt-4">
              <RepoStatusBadge
                status={repoConnection.status as any}
                totalFiles={repoConnection.totalFiles}
                totalSymbols={repoConnection.totalSymbols}
              />
            </div>
          )}

          <div className="flex justify-between mt-6 pt-4 border-t">
            <Button
              variant="outline"
              onClick={() => setCurrentStep((s) => s - 1)}
              disabled={currentStep === 0}
            >
              Back
            </Button>
            <div className="flex gap-2">
              {currentStep === STEPS.length - 1 ? (
                <>
                  {config.paymentMethod !== "stripe" ? (
                    <Button
                      variant="outline"
                      onClick={() => handleSubmit(true)}
                      disabled={isSubmitting}
                    >
                      Save as draft
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    onClick={handleAIGenerate}
                    disabled={isSubmitting || isConnectingRepo}
                  >
                    {isSubmitting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4 mr-2" />
                    )}
                    AI Generate Tests
                  </Button>
                  <Button
                    onClick={() => handleSubmit(config.paymentMethod === "stripe" ? true : false)}
                    disabled={isSubmitting || (config.paymentMethod !== "stripe" && !isCertified)}
                    title={
                      config.paymentMethod !== "stripe" && !isCertified
                        ? "Accept the Terms of Service to publish"
                        : undefined
                    }
                  >
                    {isSubmitting
                      ? config.paymentMethod === "stripe" ? "Creating draft..." : "Publishing..."
                      : config.paymentMethod === "stripe" ? "Create draft" : "Publish bounty"}
                  </Button>
                </>
              ) : (
                <Button
                  onClick={() => setCurrentStep((s) => s + 1)}
                  disabled={!canProceedToNextStep(currentStep, basics, config)}
                >
                  Next
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
