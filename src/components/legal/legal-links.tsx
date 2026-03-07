import Link from "next/link";

interface LegalLinksProps {
  className?: string;
  linkClassName?: string;
  separatorClassName?: string;
}

export function LegalLinks({
  className,
  linkClassName = "hover:text-foreground transition-colors",
  separatorClassName = "text-muted-foreground/60",
}: LegalLinksProps) {
  return (
    <div className={className}>
      <Link href="/terms" className={linkClassName}>
        Terms
      </Link>
      <span className={separatorClassName}>/</span>
      <Link href="/privacy" className={linkClassName}>
        Privacy
      </Link>
    </div>
  );
}
