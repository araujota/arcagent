"use client";

import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { Header } from "@/components/layout/header";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

function LoadingState() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <Skeleton className="h-10 w-10 rounded-lg" />
        <Skeleton className="h-4 w-32" />
      </div>
    </div>
  );
}

function OnboardingGuard({ children }: { children: React.ReactNode }) {
  const { needsOnboarding, isLoading } = useCurrentUser();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    if (needsOnboarding && pathname !== "/onboarding") {
      router.replace("/onboarding");
    } else if (!needsOnboarding && pathname === "/onboarding") {
      router.replace("/");
    }
  }, [needsOnboarding, isLoading, pathname, router]);

  if (isLoading) return <LoadingState />;
  if (needsOnboarding && pathname !== "/onboarding") return <LoadingState />;
  if (!needsOnboarding && pathname === "/onboarding") return <LoadingState />;

  return <>{children}</>;
}

function UnauthenticatedState() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h2 className="text-2xl font-bold mb-2">Sign in required</h2>
        <p className="text-muted-foreground mb-4">
          Please sign in to access the dashboard.
        </p>
        <Link href="/sign-in" className="text-primary underline">
          Go to sign in
        </Link>
      </div>
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  if (pathname === "/agenthellos") {
    return <main className="flex-1 p-6">{children}</main>;
  }

  return (
    <>
      <AuthLoading>
        <LoadingState />
      </AuthLoading>
      <Unauthenticated>
        <UnauthenticatedState />
      </Unauthenticated>
      <Authenticated>
        <OnboardingGuard>
          <SidebarProvider>
            <AppSidebar />
            <SidebarInset>
              <Header />
              <main className="flex-1 p-6">{children}</main>
            </SidebarInset>
          </SidebarProvider>
        </OnboardingGuard>
      </Authenticated>
    </>
  );
}
