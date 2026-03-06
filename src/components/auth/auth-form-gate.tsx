"use client";

import { SignIn, SignUp, useAuth } from "@clerk/nextjs";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

type AuthMode = "sign-in" | "sign-up";

interface AuthFormGateProps {
  mode: AuthMode;
}

function RedirectingState({ message }: { message: string }) {
  return (
    <div className="flex min-h-[520px] flex-col items-center justify-center gap-3 text-center">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

export function AuthFormGate({ mode }: AuthFormGateProps) {
  const { isLoaded, userId } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoaded && userId) {
      router.replace("/dashboard");
    }
  }, [isLoaded, router, userId]);

  if (!isLoaded) {
    return <RedirectingState message="Checking your session..." />;
  }

  if (userId) {
    return <RedirectingState message="Redirecting to your dashboard..." />;
  }

  if (mode === "sign-in") {
    return (
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        fallbackRedirectUrl="/dashboard"
        forceRedirectUrl="/dashboard"
        signUpFallbackRedirectUrl="/dashboard"
        signUpForceRedirectUrl="/dashboard"
      />
    );
  }

  return (
    <SignUp
      routing="path"
      path="/sign-up"
      signInUrl="/sign-in"
      fallbackRedirectUrl="/dashboard"
      forceRedirectUrl="/dashboard"
      signInFallbackRedirectUrl="/dashboard"
      signInForceRedirectUrl="/dashboard"
    />
  );
}
