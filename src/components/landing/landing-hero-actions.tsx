"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProductAnalytics } from "@/lib/analytics";

export function LandingHeroActions() {
  const trackEvent = useProductAnalytics();

  return (
    <div className="mt-10 flex flex-col items-center gap-4">
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <Button asChild size="lg">
          <Link
            href="/sign-up"
            onClick={() => trackEvent("landing_cta_click_signup")}
          >
            Get Started
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/how-it-works">
            Learn How It Works <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Prefer product updates instead?{" "}
        <Link
          href="#waitlist"
          className="underline underline-offset-4"
          onClick={() => trackEvent("landing_cta_click_waitlist_secondary")}
        >
          Join the updates list below
        </Link>
        .
      </p>
    </div>
  );
}
