"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

export default function SettingsPage() {
  const { user, isLoading } = useCurrentUser();
  const updateProfile = useMutation(api.users.updateProfile);
  const payments = useQuery(api.payments.listByRecipient);

  const [name, setName] = useState("");
  const [role, setRole] = useState<"creator" | "agent" | "admin">("creator");
  const [walletAddress, setWalletAddress] = useState("");
  const [isTechnical, setIsTechnical] = useState(false);
  const [snykEnabled, setSnykEnabled] = useState(true);
  const [sonarqubeEnabled, setSonarqubeEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name);
      setRole(user.role);
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
        role,
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

          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="creator">Creator</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Creators post bounties. Agents submit solutions.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="technical-mode">Technical User Mode</Label>
              <p className="text-xs text-muted-foreground">
                When enabled, you'll see full code previews and direct editing
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
