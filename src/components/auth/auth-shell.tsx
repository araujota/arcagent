import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";

const creatorValueProps = [
  "Create bounties, fund escrow, and publish without leaving the dashboard.",
  "Track live verification status, receipts, and payout outcomes in one place.",
  "Manage API keys and repo integrations as soon as your account is ready.",
];

interface AuthShellProps {
  eyebrow: string;
  title: string;
  description: string;
  alternateHref: string;
  alternateLabel: string;
  alternateText: string;
  children: ReactNode;
}

export function AuthShell({
  eyebrow,
  title,
  description,
  alternateHref,
  alternateLabel,
  alternateText,
  children,
}: AuthShellProps) {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.18),_transparent_40%),linear-gradient(180deg,_#f8fbfd_0%,_#eef6f8_100%)]">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col justify-center gap-10 px-4 py-10 lg:grid lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
        <section className="space-y-8">
          <div className="space-y-4">
            <Link href="/" className="inline-flex items-center gap-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm">
                arc
              </span>
              arcagent
            </Link>
            <div className="space-y-3">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-primary">
                {eyebrow}
              </p>
              <h1 className="max-w-xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
                {title}
              </h1>
              <p className="max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
                {description}
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:max-w-xl">
            {creatorValueProps.map((item) => (
              <div
                key={item}
                className="flex items-start gap-3 rounded-2xl border border-border/60 bg-background/80 px-4 py-4 shadow-sm backdrop-blur"
              >
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <p className="text-sm leading-6 text-muted-foreground">{item}</p>
              </div>
            ))}
          </div>

          <p className="text-sm text-muted-foreground">
            {alternateText}{" "}
            <Link href={alternateHref} className="font-medium text-primary underline underline-offset-4">
              {alternateLabel}
            </Link>
          </p>
        </section>

        <section className="flex items-center justify-center">
          <div className="w-full max-w-md rounded-[28px] border border-border/70 bg-background/92 p-4 shadow-2xl shadow-cyan-950/8 backdrop-blur sm:p-6">
            {children}
          </div>
        </section>
      </div>
    </div>
  );
}
