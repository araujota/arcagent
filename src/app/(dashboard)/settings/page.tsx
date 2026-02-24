"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Copy, Check, Key, Plus, Trash2, CreditCard, ExternalLink } from "lucide-react";

export default function SettingsPage() {
  const { user, isLoading } = useCurrentUser();
  const updateProfile = useMutation(api.users.updateProfile);
  const payments = useQuery(api.payments.listByRecipient);
  const apiKeys = useQuery(api.apiKeys.listMyKeys);
  const generateApiKey = useMutation(api.apiKeys.generateForCurrentUser);
  const revokeApiKey = useMutation(api.apiKeys.revokeKey);
  const setupPaymentMethod = useAction(api.stripe.setupPaymentMethod);
  const setupPayoutAccount = useAction(api.stripe.setupPayoutAccount);

  const [name, setName] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [isTechnical, setIsTechnical] = useState(false);
  const [snykEnabled, setSnykEnabled] = useState(true);
  const [sonarqubeEnabled, setSonarqubeEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);
  const [settingUpPayment, setSettingUpPayment] = useState(false);
  const [settingUpPayout, setSettingUpPayout] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name);
      setWalletAddress(user.walletAddress ?? "");
      setIsTechnical(user.isTechnical ?? false);
      setSnykEnabled(user.gateSettings?.snykEnabled ?? true);
      setSonarqubeEnabled(user.gateSettings?.sonarqubeEnabled ?? true);
    }
  }, [user]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateProfile({
        name: name || undefined,
        walletAddress: walletAddress || undefined,
        isTechnical,
        gateSettings: isTechnical
          ? { snykEnabled, sonarqubeEnabled }
          : undefined,
      });
      toast.success("Profile updated");
    } catch (error) {
      toast.error("Failed to update profile");
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateKey = async () => {
    if (!newKeyName.trim()) {
      toast.error("Please enter a name for the API key");
      return;
    }
    setGeneratingKey(true);
    try {
      const result = await generateApiKey({ name: newKeyName.trim() });
      setGeneratedKey(result.rawKey);
      setNewKeyName("");
      toast.success("API key generated");
    } catch {
      toast.error("Failed to generate API key");
    } finally {
      setGeneratingKey(false);
    }
  };

  const handleCopyKey = async () => {
    if (!generatedKey) return;
    try {
      await navigator.clipboard.writeText(generatedKey);
      setKeyCopied(true);
      toast.success("API key copied!");
      setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  };

  const handleRevokeKey = async (apiKeyId: string) => {
    setRevokingKeyId(apiKeyId);
    try {
      await revokeApiKey({ apiKeyId: apiKeyId as never });
      toast.success("API key revoked");
    } catch {
      toast.error("Failed to revoke API key");
    } finally {
      setRevokingKeyId(null);
    }
  };

  const handleSetupPayment = async () => {
    setSettingUpPayment(true);
    try {
      const result = await setupPaymentMethod();
      // Redirect to Stripe-hosted payment method setup checkout.
      window.location.href = result.checkoutUrl;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to set up payment method");
    } finally {
      setSettingUpPayment(false);
    }
  };

  const handleSetupPayout = async () => {
    setSettingUpPayout(true);
    try {
      const result = await setupPayoutAccount();
      // Redirect to Stripe Connect onboarding
      window.location.href = result.onboardingUrl;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to set up payout account");
    } finally {
      setSettingUpPayout(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">
          Manage your profile and preferences.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={user?.email ?? ""} disabled />
            <p className="text-xs text-muted-foreground">
              Email is managed by your authentication provider.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="technical-mode">Technical User Mode</Label>
              <p className="text-xs text-muted-foreground">
                When enabled, you&apos;ll see full code previews and direct editing
                capabilities during test generation. Disable for a simplified,
                summary-based review experience.
              </p>
            </div>
            <Switch
              id="technical-mode"
              checked={isTechnical}
              onCheckedChange={setIsTechnical}
            />
          </div>

          {isTechnical && (
            <div className="space-y-3 rounded-lg border p-4">
              <div>
                <Label className="text-sm font-medium">
                  Verification Gate Settings
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Control which security gates run on submissions to your
                  bounties.
                </p>
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="snyk-gate">Snyk (SCA + SAST)</Label>
                  <p className="text-xs text-muted-foreground">
                    Software composition analysis and static analysis via Snyk.
                  </p>
                </div>
                <Switch
                  id="snyk-gate"
                  checked={snykEnabled}
                  onCheckedChange={setSnykEnabled}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="sonarqube-gate">SonarQube</Label>
                  <p className="text-xs text-muted-foreground">
                    Code quality and security scanning via SonarQube.
                  </p>
                </div>
                <Switch
                  id="sonarqube-gate"
                  checked={sonarqubeEnabled}
                  onCheckedChange={setSonarqubeEnabled}
                />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="wallet">Wallet Address (Optional)</Label>
            <Input
              id="wallet"
              placeholder="0x..."
              value={walletAddress}
              onChange={(e) => setWalletAddress(e.target.value)}
            />
          </div>

          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </CardContent>
      </Card>

      <Separator />

      {/* Payment Method */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            Payment Method
          </CardTitle>
          <CardDescription>
            Add or update your payment method for funding bounty escrows.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {user?.hasPaymentMethod ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge variant="default">Active</Badge>
                <span className="text-sm text-muted-foreground">
                  Payment method on file
                </span>
              </div>
              <Button variant="outline" size="sm" onClick={handleSetupPayment} disabled={settingUpPayment}>
                {settingUpPayment ? "Redirecting..." : "Update Card"}
              </Button>
            </div>
          ) : (
            <div className="text-center space-y-3 py-2">
              <p className="text-sm text-muted-foreground">
                No payment method on file. Add a card to fund bounties.
              </p>
              <Button variant="outline" onClick={handleSetupPayment} disabled={settingUpPayment}>
                <CreditCard className="h-4 w-4 mr-2" />
                {settingUpPayment ? "Redirecting to Stripe..." : "Add Payment Method"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Payout Account */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ExternalLink className="h-4 w-4" />
            Payout Account
          </CardTitle>
          <CardDescription>
            Set up your Stripe Connect account to receive bounty payouts. A 3% platform fee is deducted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {user?.stripeConnectOnboardingComplete ? (
            <div className="flex items-center gap-2">
              <Badge variant="default">Connected</Badge>
              <span className="text-sm text-muted-foreground">
                Stripe Connect account active
              </span>
            </div>
          ) : user?.stripeConnectAccountId ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">Incomplete</Badge>
                <span className="text-sm text-muted-foreground">
                  Stripe onboarding not finished
                </span>
              </div>
              <Button variant="outline" size="sm" onClick={handleSetupPayout} disabled={settingUpPayout}>
                <ExternalLink className="h-4 w-4 mr-2" />
                {settingUpPayout ? "Redirecting..." : "Complete Onboarding"}
              </Button>
            </div>
          ) : (
            <div className="text-center space-y-3 py-2">
              <p className="text-sm text-muted-foreground">
                No payout account connected. Set up Stripe Connect to receive payments.
              </p>
              <Button variant="outline" onClick={handleSetupPayout} disabled={settingUpPayout}>
                <ExternalLink className="h-4 w-4 mr-2" />
                {settingUpPayout ? "Redirecting to Stripe..." : "Connect Stripe Account"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* API Keys */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Key className="h-4 w-4" />
            API Keys
          </CardTitle>
          <CardDescription>
            Manage API keys for MCP/Claude Desktop integration.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Generate new key */}
          <div className="flex gap-2">
            <Input
              placeholder="Key name (e.g. Claude Desktop)"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleGenerateKey()}
            />
            <Button
              onClick={handleGenerateKey}
              disabled={generatingKey || !newKeyName.trim()}
              size="sm"
            >
              <Plus className="h-4 w-4 mr-1" />
              {generatingKey ? "Generating..." : "Generate"}
            </Button>
          </div>

          {/* Show newly generated key */}
          {generatedKey && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3">
              <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                Copy this key now — it won&apos;t be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-muted px-3 py-2 text-sm font-mono break-all">
                  {generatedKey}
                </code>
                <Button variant="outline" size="icon" onClick={handleCopyKey}>
                  {keyCopied ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <div className="rounded bg-muted p-3">
                <p className="text-xs font-medium mb-1">MCP Config (claude_desktop_config.json)</p>
                <pre className="text-xs text-muted-foreground overflow-auto">
{`{
  "mcpServers": {
    "arcagent": {
      "command": "npx",
      "args": ["-y", "arcagent-mcp"],
      "env": {
        "ARCAGENT_API_KEY": "${generatedKey}"
      }
    }
  }
}`}
                </pre>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setGeneratedKey(null)}
              >
                Dismiss
              </Button>
            </div>
          )}

          {/* List existing keys */}
          {apiKeys === undefined ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : apiKeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No API keys yet. Generate one to get started.
            </p>
          ) : (
            <div className="space-y-2">
              {apiKeys.map((key) => (
                <div
                  key={key._id}
                  className="flex items-center justify-between py-2 px-3 rounded-lg border"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{key.name}</span>
                      <Badge
                        variant={key.status === "active" ? "default" : "secondary"}
                      >
                        {key.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground font-mono">
                      {key.keyPrefix}... &middot; Created{" "}
                      {new Date(key.createdAt).toLocaleDateString()}
                      {key.lastUsedAt && (
                        <> &middot; Last used {new Date(key.lastUsedAt).toLocaleDateString()}</>
                      )}
                    </p>
                  </div>
                  {key.status === "active" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRevokeKey(key._id)}
                      disabled={revokingKeyId === key._id}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payment History</CardTitle>
        </CardHeader>
        <CardContent>
          {payments === undefined ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No payment history yet.
            </p>
          ) : (
            <div className="space-y-3">
              {payments.map((payment) => (
                <div
                  key={payment._id}
                  className="flex items-center justify-between py-2 border-b last:border-0"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {payment.bounty?.title ?? "Unknown Bounty"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(payment.createdAt).toLocaleDateString()}
                      {payment.transactionId && (
                        <span className="ml-2 font-mono">
                          {payment.transactionId.slice(0, 16)}...
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {payment.amount} {payment.currency}
                    </span>
                    <Badge
                      variant={
                        payment.status === "completed"
                          ? "default"
                          : payment.status === "failed"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {payment.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
