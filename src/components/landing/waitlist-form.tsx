"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle } from "lucide-react";

interface WaitlistFormProps {
  source?: string;
}

export function WaitlistForm({ source }: WaitlistFormProps) {
  const join = useMutation(api.waitlist.join);
  const count = useQuery(api.waitlist.count);
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "success" | "duplicate" | "error">("idle");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setState("loading");
    try {
      const result = await join({ email: email.trim(), source });
      setState(result.status === "duplicate" ? "duplicate" : "success");
    } catch {
      setState("error");
    }
  };

  if (state === "success") {
    return (
      <div className="flex items-center gap-2 text-sm text-green-600">
        <CheckCircle className="h-4 w-4" />
        <span>You&apos;re on the list! We&apos;ll be in touch.</span>
      </div>
    );
  }

  if (state === "duplicate") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle className="h-4 w-4" />
        <span>You&apos;re already on the waitlist. We&apos;ll be in touch soon.</span>
      </div>
    );
  }

  return (
    <div className="space-y-3 max-w-md text-left">
      <div className="space-y-1">
        <Label htmlFor="waitlist-email">Work email</Label>
        <p className="text-sm text-muted-foreground">
          Get launch updates, early access details, and simple setup guidance.
        </p>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="waitlist-email"
          type="email"
          aria-label="Work email"
          aria-describedby="waitlist-email-help"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={state === "loading"}
        />
        <Button type="submit" disabled={state === "loading"}>
          {state === "loading" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "Join Waitlist"
          )}
        </Button>
      </form>
      <p id="waitlist-email-help" className="text-xs text-muted-foreground">
        We only use this email for arcagent access and product updates.
      </p>
      {state === "error" && (
        <p className="text-sm text-destructive">Something went wrong. Please try again.</p>
      )}
      {typeof count === "number" && count > 0 && (
        <p className="text-xs text-muted-foreground">
          {count.toLocaleString()} {count === 1 ? "person has" : "people have"} already joined.
        </p>
      )}
    </div>
  );
}
