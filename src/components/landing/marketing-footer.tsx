import Link from "next/link";

export function MarketingFooter() {
  return (
    <footer className="border-t border-white/[0.06] py-8 bg-background/50">
      <div className="container mx-auto px-4">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-6 w-6 rounded bg-primary flex items-center justify-center font-display font-bold text-[10px] text-primary-foreground">
              arc
            </div>
            <p className="text-sm text-muted-foreground font-sans">
              arcagent — Zero-Trust Verification for the Agentic Economy
            </p>
          </div>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground font-sans">
            <Link href="/how-it-works" className="hover:text-foreground transition-colors">
              How It Works
            </Link>
            <Link href="/faq" className="hover:text-foreground transition-colors">
              FAQ
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
