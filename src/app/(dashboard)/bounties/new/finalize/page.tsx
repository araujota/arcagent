"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { Id } from "../../../../../../convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";

function formatDeadline(deadline?: number): string {
  if (!deadline) return "";
  return new Date(deadline).toISOString().slice(0, 10);
}

export default function FinalizeBountyDraftPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const bountyId = searchParams.get("bountyId") as Id<"bounties"> | null;
  const bounty = useQuery(api.bounties.getById, bountyId ? { bountyId } : "skip");
  const generatedTest = useQuery(api.generatedTests.getByBountyId, bountyId ? { bountyId } : "skip");
  const finalizeStagedCreation = useAction(api.orchestrator.finalizeStagedCreation);

  const [reward, setReward] = useState("50");
  const [rewardCurrency, setRewardCurrency] = useState("USD");
  const [paymentMethod, setPaymentMethod] = useState<"stripe" | "web3">("stripe");
  const [deadline, setDeadline] = useState("");
  const [tags, setTags] = useState("");
  const [requiredTier, setRequiredTier] = useState<string>("none");
  const [tosAccepted, setTosAccepted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!bounty) return;
    setReward(String(bounty.reward ?? 50));
    setRewardCurrency(bounty.rewardCurrency ?? "USD");
    setPaymentMethod((bounty.paymentMethod as "stripe" | "web3") ?? "stripe");
    setDeadline(formatDeadline(bounty.deadline));
    setTags((bounty.tags ?? []).join(", "));
    setRequiredTier(bounty.requiredTier ?? "none");
  }, [bounty]);

  if (!bountyId) {
    return <div className="py-12 text-center text-muted-foreground">Missing bountyId.</div>;
  }

  if (bounty === undefined || generatedTest === undefined) {
    return <div className="py-12 text-center text-muted-foreground">Loading final screen...</div>;
  }

  if (!bounty || !generatedTest) {
    return <div className="py-12 text-center text-muted-foreground">Draft artifacts not found.</div>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/bounties/new/generate?bountyId=${bountyId}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold">Screen 3: Finalize and Publish</h1>
          <p className="text-sm text-muted-foreground">{bounty.title}</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Commercial settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="reward">Reward</Label>
              <Input
                id="reward"
                type="number"
                min={50}
                value={reward}
                onChange={(event) => setReward(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="currency">Currency</Label>
              <Select value={rewardCurrency} onValueChange={setRewardCurrency}>
                <SelectTrigger id="currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USD">USD</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="payment">Payment method</Label>
            <Select value={paymentMethod} onValueChange={(value) => setPaymentMethod(value as "stripe" | "web3")}>
              <SelectTrigger id="payment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stripe">Stripe</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="deadline">Deadline</Label>
            <Input
              id="deadline"
              type="date"
              value={deadline}
              onChange={(event) => setDeadline(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tags">Tags</Label>
            <Input id="tags" value={tags} onChange={(event) => setTags(event.target.value)} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tier">Minimum tier</Label>
            <Select value={requiredTier} onValueChange={setRequiredTier}>
              <SelectTrigger id="tier">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No requirement</SelectItem>
                <SelectItem value="D">D</SelectItem>
                <SelectItem value="C">C</SelectItem>
                <SelectItem value="B">B</SelectItem>
                <SelectItem value="A">A</SelectItem>
                <SelectItem value="S">S</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-start gap-3 rounded-md border p-3">
            <Checkbox checked={tosAccepted} onCheckedChange={(checked) => setTosAccepted(checked === true)} />
            <div>
              <p className="text-sm font-medium">Agree to bounty creation terms</p>
              <p className="text-xs text-muted-foreground">
                Required before the bounty can be published.
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={isSubmitting}
              onClick={async () => {
                setIsSubmitting(true);
                try {
                  await finalizeStagedCreation({
                    bountyId,
                    generatedTestId: generatedTest._id,
                    reward: Number(reward),
                    rewardCurrency,
                    paymentMethod,
                    deadline: deadline ? new Date(deadline).getTime() : undefined,
                    tags: tags
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                    requiredTier: requiredTier === "none" ? undefined : (requiredTier as any),
                    tosAccepted,
                    tosAcceptedAt: Date.now(),
                    tosVersion: "1.0",
                    publishNow: false,
                  });
                  toast.success("Draft finalized");
                  router.push(`/bounties/${bountyId}`);
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Failed to finalize draft");
                } finally {
                  setIsSubmitting(false);
                }
              }}
            >
              Save finalized draft
            </Button>
            <Button
              disabled={isSubmitting || !tosAccepted}
              onClick={async () => {
                setIsSubmitting(true);
                try {
                  await finalizeStagedCreation({
                    bountyId,
                    generatedTestId: generatedTest._id,
                    reward: Number(reward),
                    rewardCurrency,
                    paymentMethod,
                    deadline: deadline ? new Date(deadline).getTime() : undefined,
                    tags: tags
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                    requiredTier: requiredTier === "none" ? undefined : (requiredTier as any),
                    tosAccepted,
                    tosAcceptedAt: Date.now(),
                    tosVersion: "1.0",
                    publishNow: true,
                  });
                  toast.success("Bounty published");
                  router.push(`/bounties/${bountyId}`);
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Failed to publish bounty");
                } finally {
                  setIsSubmitting(false);
                }
              }}
            >
              Publish now
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
