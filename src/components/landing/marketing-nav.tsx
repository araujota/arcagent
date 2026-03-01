"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useProductAnalytics } from "@/lib/analytics";

export function MarketingNav() {
  const pathname = usePathname();
  const trackEvent = useProductAnalytics();
  const waitlistHref = pathname === "/" ? "#waitlist" : "/#waitlist";

  return (
    <header className="sticky top-0 z-50 border-b border-border/70 bg-background/85 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
      <div className="container mx-auto flex items-center justify-between h-16 px-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-cyan-400 text-primary-foreground flex items-center justify-center font-bold text-sm shadow-md">
              arc
            </div>
            <span className="font-semibold text-lg">arcagent</span>
          </Link>
          <nav className="hidden sm:flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/how-it-works" className="hover:text-foreground transition-colors">
              How It Works
            </Link>
            <Link href="/faq" className="hover:text-foreground transition-colors">
              FAQ
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="ghost" asChild>
            <Link
              href={waitlistHref}
              onClick={() => trackEvent("landing_cta_click_waitlist_secondary")}
            >
              Join Waitlist
            </Link>
          </Button>
          <Button className="shadow-md shadow-primary/20" asChild>
            <Link
              href="/sign-up"
              onClick={() => trackEvent("landing_cta_click_signup")}
            >
              Get Started
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
