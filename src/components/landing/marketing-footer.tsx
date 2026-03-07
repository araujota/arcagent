import Link from "next/link";
import { LegalLinks } from "@/components/legal/legal-links";

export function MarketingFooter() {
  return (
    <footer className="border-t border-border/70 bg-gradient-to-b from-transparent to-cyan-100/35 py-8">
      <div className="container mx-auto px-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            arcagent - Coding bounties with automatic verification and payout
          </p>
          <nav className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <Link href="/how-it-works" className="hover:text-foreground transition-colors">
              How It Works
            </Link>
            <Link href="/faq" className="hover:text-foreground transition-colors">
              FAQ
            </Link>
            <LegalLinks className="flex items-center gap-2" />
            <Link href="/sign-in" className="hover:text-foreground transition-colors">
              Sign In
            </Link>
            <Link href="/sign-up" className="hover:text-foreground transition-colors">
              Get Started
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
