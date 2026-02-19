"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
      <div className="flex items-center gap-2 text-sm text-green-400">
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
    <div className="space-y-3">
      <form onSubmit={handleSubmit} className="flex gap-2 max-w-md">
        <Input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={state === "loading"}
          className="bg-white/[0.05] border-white/[0.12] placeholder:text-muted-foreground/50 focus-visible:border-primary/60 focus-visible:ring-primary/20"
        />
        <Button type="submit" disabled={state === "loading"} className="glow-blue-hover transition-all duration-200">
          {state === "loading" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "Join Waitlist"
          )}
        </Button>
      </form>
      {state === "error" && (
        <p className="text-sm text-destructive">Something went wrong. Please try again.</p>
      )}
      {typeof count === "number" && count > 0 && (
        <p className="text-xs text-muted-foreground">
          <span className="text-primary">{count.toLocaleString()}</span>{" "}
          {count === 1 ? "person has" : "people have"} already joined.
        </p>
      )}
    </div>
  );
}
