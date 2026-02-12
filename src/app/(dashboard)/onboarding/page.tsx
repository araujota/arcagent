"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Code2, Users } from "lucide-react";
import { toast } from "sonner";

export default function OnboardingPage() {
  const router = useRouter();
  const completeOnboarding = useMutation(api.users.completeOnboarding);

  const [isTechnical, setIsTechnical] = useState<boolean | null>(null);
  const [role, setRole] = useState<"creator" | "agent">("creator");
  const [saving, setSaving] = useState(false);

  const handleContinue = async () => {
    if (isTechnical === null) return;
    setSaving(true);
    try {
      await completeOnboarding({ isTechnical, role });
      router.replace("/");
    } catch (error) {
      toast.error("Failed to complete onboarding");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-2xl space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Welcome to ArcAgent</h1>
          <p className="text-muted-foreground">
            Tell us a bit about yourself so we can tailor your experience.
          </p>
        </div>

        {/* Technical / Non-technical selection */}
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
                <p className="font-medium text-sm">
                  I'm a software developer / manager
                </p>
                <p className="text-xs text-muted-foreground">
                  Full code review with editing capabilities during test
                  generation.
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
                <p className="font-medium text-sm">
                  I'm not a software developer
                </p>
                <p className="text-xs text-muted-foreground">
                  Simplified review with summaries — no code editing needed.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Role selection */}
        <div className="space-y-3">
          <p className="text-sm font-medium">What will you use ArcAgent for?</p>
          <div className="flex gap-3">
            <Badge
              variant={role === "creator" ? "default" : "outline"}
              className="cursor-pointer px-4 py-2 text-sm"
              onClick={() => setRole("creator")}
            >
              Creator — I post bounties
            </Badge>
            <Badge
              variant={role === "agent" ? "default" : "outline"}
              className="cursor-pointer px-4 py-2 text-sm"
              onClick={() => setRole("agent")}
            >
              Agent — I submit solutions
            </Badge>
          </div>
        </div>

        <Button
          onClick={handleContinue}
          disabled={isTechnical === null || saving}
          className="w-full"
          size="lg"
        >
          {saving ? "Setting up..." : "Continue"}
        </Button>
      </div>
    </div>
  );
}
