"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useMutation, useAction, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StepBasics, type BasicsData } from "./step-basics";
import { StepTests, type TestsData } from "./step-tests";
import { StepConfig, type ConfigData } from "./step-config";
import { StepReview } from "./step-review";
import { RepoStatusBadge } from "@/components/bounties/repo-status-badge";
import { useProductAnalytics } from "@/lib/analytics";
import { toast } from "sonner";
import { Sparkles, Loader2 } from "lucide-react";

const WIZARD_STORAGE_KEY = "arcagent_bounty_wizard_draft";

const STEPS = ["Basics", "Tests", "Config", "Review"] as const;

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

  const canGoNext = () => {
    switch (currentStep) {
      case 0:
        return basics.title.trim() && basics.description.trim() && basics.reward >= 50;
      case 1:
        return basics.title.trim(); // tests are optional
      case 2:
        if (config.requiredTier === "S" && basics.reward < 150) return false;
        return true;
      default:
        return false;
    }
  };

  const handleSubmit = async (asDraft: boolean) => {
    setIsSubmitting(true);
    try {
      const tags = config.tags
        ? [...new Set(config.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))]
        : undefined;

      const bountyId = await createBounty({
        title: basics.title,
        description: basics.description,
        reward: basics.reward,
        rewardCurrency: basics.rewardCurrency,
        paymentMethod: config.paymentMethod,
        deadline: config.deadline ? new Date(config.deadline).getTime() : undefined,
        repositoryUrl: config.repositoryUrl || undefined,
        tags,
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
      if (config.repositoryUrl && repoProvider === "github") {
        const permission = (await getGitHubPermissionStatus({
          repositoryUrl: config.repositoryUrl,
        })) as GitHubPermissionStatus;
        setGithubPermissionStatus(permission);
        if (permission.appConfigured && !permission.hasInstallation) {
          toast.error("Install the Arcagent GitHub App for this repository before indexing.");
          return;
        }
      }

      if (config.repositoryUrl && oauthRepoProvider) {
        if (providerConnections === undefined) {
          toast.error("Checking repository integration status. Try again in a moment.");
          return;
        }
        if (!oauthRepoConnection) {
          toast.error(
            `Connect your ${oauthRepoProvider === "gitlab" ? "GitLab" : "Bitbucket"} account before indexing this repository.`,
          );
          return;
        }
      }

      const tags = config.tags
        ? [...new Set(config.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))]
        : undefined;

      // Create the bounty first (as draft)
      const bountyId = await createBounty({
        title: basics.title,
        description: basics.description,
        reward: basics.reward,
        rewardCurrency: basics.rewardCurrency,
        paymentMethod: config.paymentMethod,
        deadline: config.deadline ? new Date(config.deadline).getTime() : undefined,
        repositoryUrl: config.repositoryUrl || undefined,
        tags,
        status: "draft",
        requiredTier: config.requiredTier,
      });

      setCreatedBountyId(bountyId);

      // If a repo URL is provided, connect and start indexing
      if (config.repositoryUrl) {
        setIsConnectingRepo(true);
        try {
          await connectRepo({
            bountyId,
            repositoryUrl: config.repositoryUrl,
          });
          toast.success("Repository connected. Indexing started.");
        } catch (repoErr) {
          toast.error(
            repoErr instanceof Error
              ? `Repository error: ${repoErr.message}`
              : "Failed to connect repository. You can still generate tests."
          );
        } finally {
          setIsConnectingRepo(false);
        }
      }

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
          <div key={step} className="flex items-center">
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
              <span className="text-xs mt-1 text-muted-foreground">{step}</span>
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
          <CardTitle>{STEPS[currentStep]}</CardTitle>
        </CardHeader>
        <CardContent>
          {currentStep === 0 && (
            <StepBasics data={basics} onChange={setBasics} />
          )}
          {currentStep === 1 && (
            <StepTests data={tests} onChange={setTests} />
          )}
          {currentStep === 2 && (
            <StepConfig data={config} onChange={setConfig} reward={basics.reward} />
          )}
          {currentStep === 2 && repoProvider === "github" && (
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
                  onClick={handleCheckGithubPermission}
                  disabled={isCheckingGithubPermission}
                >
                  {isCheckingGithubPermission ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : null}
                  Check GitHub Access
                </Button>
                {githubPermissionStatus?.appConfigured &&
                  !githubPermissionStatus.hasInstallation &&
                  githubPermissionStatus.installUrl && (
                    <Button asChild size="sm">
                      <a
                        href={githubPermissionStatus.installUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Install GitHub App
                      </a>
                    </Button>
                  )}
              </div>
              {githubPermissionStatus?.appConfigured && githubPermissionStatus.hasInstallation && (
                <p className="text-xs text-green-700">
                  Installation detected. Repo-scoped credentials will be minted automatically.
                </p>
              )}
              {githubPermissionStatus?.appConfigured && !githubPermissionStatus.hasInstallation && (
                <p className="text-xs text-amber-700">
                  No GitHub App installation found for this repository yet.
                </p>
              )}
              {githubPermissionStatus && !githubPermissionStatus.appConfigured && (
                <p className="text-xs text-muted-foreground">
                  GitHub App is not configured in this environment. Falling back to legacy token settings.
                </p>
              )}
            </div>
          )}
          {currentStep === 2 && oauthRepoProvider && (
            <div className="mt-4 rounded-md border p-3 space-y-2">
              <p className="text-sm font-medium">
                {oauthRepoProvider === "gitlab" ? "GitLab OAuth Access" : "Bitbucket OAuth Access"}
              </p>
              <p className="text-xs text-muted-foreground">
                Arcagent uses your connected account token for indexing, workspace cloning, and
                auto publish of review requests for this repository provider.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {oauthRepoConnection ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => router.push("/settings")}
                  >
                    Manage Connection
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleConnectOAuthProvider}
                    disabled={isStartingProviderOAuth}
                  >
                    {isStartingProviderOAuth ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : null}
                    Connect {oauthRepoProvider === "gitlab" ? "GitLab" : "Bitbucket"}
                  </Button>
                )}
              </div>
              {oauthRepoConnection ? (
                <p className="text-xs text-green-700">
                  Connected as {oauthRepoConnection.accountName || oauthRepoConnection.accountId || "account"}.
                </p>
              ) : (
                <p className="text-xs text-amber-700">
                  No active {oauthRepoProvider === "gitlab" ? "GitLab" : "Bitbucket"} connection found for your user.
                </p>
              )}
            </div>
          )}
          {currentStep === 3 && (
            <StepReview
              basics={basics}
              tests={tests}
              config={config}
              isCertified={isCertified}
              onCertificationChange={setIsCertified}
            />
          )}

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
                  <Button
                    variant="outline"
                    onClick={() => handleSubmit(true)}
                    disabled={isSubmitting}
                  >
                    Save as Draft
                  </Button>
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
                    disabled={isSubmitting || !isCertified}
                    title={!isCertified ? "Accept the Terms of Service to publish" : undefined}
                  >
                    {isSubmitting
                      ? config.paymentMethod === "stripe" ? "Saving..." : "Publishing..."
                      : config.paymentMethod === "stripe" ? "Save Draft" : "Publish Bounty"}
                  </Button>
                </>
              ) : (
                <Button
                  onClick={() => setCurrentStep((s) => s + 1)}
                  disabled={!canGoNext()}
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
