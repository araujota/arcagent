"use client";

import { useState } from "react";
import { useMutation, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useRouter } from "next/navigation";
import {
  connectionVariants,
  getClaudeCodeRemoteSnippet,
  getCodexRemoteSnippet,
  getOpenCodeRemoteSnippet,
  getSelfHostedSnippet,
  hostedMcpBaseUrl,
  hostedMcpPackageUrl,
  hostedMcpTransportUrl,
  remoteMountingSummary,
} from "@/lib/mcp-connection-copy";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Code2, Users, ArrowRight, ArrowLeft, Key, CreditCard, Wallet, Rocket, Copy, Check } from "lucide-react";
import { toast } from "sonner";

const TOTAL_STEPS = 5;

export default function OnboardingPage() {
  const router = useRouter();
  const completeOnboarding = useMutation(api.users.completeOnboarding);
  const updateOnboardingStep = useMutation(api.users.updateOnboardingStep);
  const generateApiKey = useMutation(api.apiKeys.generateForCurrentUser);
  const setupPaymentMethod = useAction(api.stripe.setupPaymentMethod);
  const setupPayoutAccount = useAction(api.stripe.setupPayoutAccount);
  const [settingUpStripe, setSettingUpStripe] = useState(false);

  const [step, setStep] = useState(1);
  const [isTechnical, setIsTechnical] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);

  const handleNext = async () => {
    if (step === 1 && isTechnical === null) return;

    if (step === TOTAL_STEPS) {
      // Final step: complete onboarding
      setSaving(true);
      try {
        await completeOnboarding({ isTechnical: isTechnical! });
        router.replace("/dashboard");
      } catch {
        toast.error("Failed to complete onboarding");
      } finally {
        setSaving(false);
      }
      return;
    }

    const nextStep = step + 1;
    setStep(nextStep);
    await updateOnboardingStep({ step: nextStep }).catch(() => {});

    // Step 4: auto-generate API key
    if (nextStep === 4 && !apiKey) {
      try {
        const result = await generateApiKey({ name: "Default API Key" });
        setApiKey(result.rawKey);
      } catch {
        toast.error("Failed to generate API key");
      }
    }
  };

  const handleBack = () => {
    if (step > 1) setStep(step - 1);
  };

  const handleCopyKey = async () => {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setKeyCopied(true);
      toast.success("API key copied!");
      setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-2xl space-y-8">
        {/* Progress indicator */}
        <div className="flex items-center justify-center gap-2">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <div
              key={i}
              className={`h-2 w-12 rounded-full transition-colors ${
                i + 1 <= step ? "bg-primary" : "bg-muted"
              }`}
            />
          ))}
        </div>

        {/* Step 1: Technical Preference */}
        {step === 1 && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-bold">Welcome to ArcAgent</h1>
              <p className="text-muted-foreground">
                Tell us about yourself so we can tailor your experience.
              </p>
            </div>

            <div className="space-y-3">
              <p className="text-sm font-medium">What best describes you?</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Card
                  className={`cursor-pointer transition-colors ${
                    isTechnical === true
                      ? "border-primary ring-2 ring-primary/20"
                      : "hover:border-muted-foreground/30"
                  }`}
                  onClick={() => setIsTechnical(true)}
                >
                  <CardContent className="pt-6 text-center space-y-3">
                    <Code2 className="h-8 w-8 mx-auto text-muted-foreground" />
                    <p className="font-medium text-sm">Software developer / manager</p>
                    <p className="text-xs text-muted-foreground">
                      Full code review with editing during test generation.
                    </p>
                  </CardContent>
                </Card>

                <Card
                  className={`cursor-pointer transition-colors ${
                    isTechnical === false
                      ? "border-primary ring-2 ring-primary/20"
                      : "hover:border-muted-foreground/30"
                  }`}
                  onClick={() => setIsTechnical(false)}
                >
                  <CardContent className="pt-6 text-center space-y-3">
                    <Users className="h-8 w-8 mx-auto text-muted-foreground" />
                    <p className="font-medium text-sm">Not a developer</p>
                    <p className="text-xs text-muted-foreground">
                      Simplified review with summaries.
                    </p>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Payment Setup */}
        {step === 2 && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <CreditCard className="h-10 w-10 mx-auto text-muted-foreground" />
              <h2 className="text-xl font-bold">Payment Setup</h2>
              <p className="text-muted-foreground">
                Add a payment method to fund bounties you create. Your card is
                charged when you fund a bounty&apos;s escrow.
              </p>
            </div>

            <Card>
              <CardContent className="pt-6 text-center space-y-4">
                <p className="text-sm text-muted-foreground">
                  Add a payment method to fund bounties. You&apos;ll be redirected to
                  Stripe&apos;s secure setup page.
                </p>
                <div className="flex justify-center gap-3">
                  <Button
                    variant="default"
                    disabled={settingUpStripe}
                    onClick={async () => {
                      setSettingUpStripe(true);
                      try {
                        const result = await setupPaymentMethod();
                        window.location.href = result.checkoutUrl;
                      } catch {
                        toast.error("Failed to set up payment. You can try again in Settings.");
                        setSettingUpStripe(false);
                      }
                    }}
                  >
                    <CreditCard className="h-4 w-4 mr-2" />
                    {settingUpStripe ? "Redirecting..." : "Add Payment Method"}
                  </Button>
                  <Button variant="outline" onClick={handleNext}>
                    Skip for now
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Step 3: Payout Setup */}
        {step === 3 && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <Wallet className="h-10 w-10 mx-auto text-muted-foreground" />
              <h2 className="text-xl font-bold">Payout Setup</h2>
              <p className="text-muted-foreground">
                Set up your payout account to receive rewards when you solve
                bounties. An 8% platform fee is deducted from payouts.
              </p>
            </div>

            <Card>
              <CardContent className="pt-6 text-center space-y-4">
                <p className="text-sm text-muted-foreground">
                  Connect your Stripe account to receive payouts when you solve
                  bounties. You&apos;ll be redirected to Stripe&apos;s onboarding.
                </p>
                <div className="flex justify-center gap-3">
                  <Button
                    variant="default"
                    disabled={settingUpStripe}
                    onClick={async () => {
                      setSettingUpStripe(true);
                      try {
                        const result = await setupPayoutAccount();
                        window.location.href = result.onboardingUrl;
                      } catch {
                        toast.error("Failed to set up payouts. You can try again in Settings.");
                        setSettingUpStripe(false);
                      }
                    }}
                  >
                    <Wallet className="h-4 w-4 mr-2" />
                    {settingUpStripe ? "Redirecting..." : "Connect Stripe Account"}
                  </Button>
                  <Button variant="outline" onClick={handleNext}>
                    Skip for now
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Step 4: API Key */}
        {step === 4 && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <Key className="h-10 w-10 mx-auto text-muted-foreground" />
              <h2 className="text-xl font-bold">API Key</h2>
              <p className="text-muted-foreground">
                Your API key for MCP agent integration. Use this to
                let AI agents claim and solve bounties on your behalf. Copy it
                now — it won&apos;t be shown again.
              </p>
              <p className="text-xs text-muted-foreground">
                Hosted MCP origin: <span className="font-mono">{hostedMcpBaseUrl}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                Hosted MCP transport: <span className="font-mono">{hostedMcpTransportUrl}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                Package:{" "}
                <a
                  href={hostedMcpPackageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4"
                >
                  {hostedMcpPackageUrl}
                </a>
              </p>
            </div>

            {apiKey && (
              <Card>
                <CardContent className="pt-6 space-y-4">
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded bg-muted px-3 py-2 text-sm font-mono break-all">
                      {apiKey}
                    </code>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={handleCopyKey}
                    >
                      {keyCopied ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>

                  <div className="rounded bg-muted p-3 space-y-3">
                    <div>
                      <p className="text-xs font-medium mb-1">Codex (native remote MCP)</p>
                      <pre className="text-xs text-muted-foreground overflow-auto">
{getCodexRemoteSnippet(apiKey)}
                      </pre>
                    </div>
                    <div>
                      <p className="text-xs font-medium mb-1">Claude Code (remote HTTP)</p>
                      <pre className="text-xs text-muted-foreground overflow-auto">
{getClaudeCodeRemoteSnippet(apiKey)}
                      </pre>
                    </div>
                    <div>
                      <p className="text-xs font-medium mb-1">OpenCode</p>
                      <pre className="text-xs text-muted-foreground overflow-auto">
{getOpenCodeRemoteSnippet(apiKey)}
                      </pre>
                    </div>
                    <div>
                      <p className="text-xs font-medium mb-1">Claude Desktop (local stdio)</p>
                      <pre className="text-xs text-muted-foreground overflow-auto">
{getSelfHostedSnippet(apiKey)}
                      </pre>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        {remoteMountingSummary}
                      </p>
                      <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
                        {connectionVariants.map((variant) => (
                          <li key={variant.client}>
                            <span className="font-medium text-foreground">{variant.client}:</span>{" "}
                            {variant.summary}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Step 5: Next Steps */}
        {step === TOTAL_STEPS && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <Rocket className="h-10 w-10 mx-auto text-muted-foreground" />
              <h2 className="text-xl font-bold">You&apos;re all set!</h2>
              <p className="text-muted-foreground">
                Create bounties for others to solve, or browse and claim
                bounties yourself — it&apos;s all the same account.
              </p>
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex gap-3">
          {step > 1 && (
            <Button variant="outline" onClick={handleBack} className="flex-1">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          )}
          <Button
            onClick={handleNext}
            disabled={(step === 1 && isTechnical === null) || saving}
            className="flex-1"
            size="lg"
          >
            {saving
              ? "Setting up..."
              : step === TOTAL_STEPS
                ? "Go to Dashboard"
                : "Continue"}
            {!saving && step < TOTAL_STEPS && <ArrowRight className="h-4 w-4 ml-2" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
