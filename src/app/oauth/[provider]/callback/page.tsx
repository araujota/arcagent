"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAction } from "convex/react";
import { useParams, useSearchParams } from "next/navigation";
import { Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type OAuthProvider = "gitlab" | "bitbucket";

function asProvider(value: string | string[] | undefined): OAuthProvider | null {
  if (typeof value !== "string") return null;
  if (value === "gitlab" || value === "bitbucket") return value;
  return null;
}

function sanitizeReturnTo(returnTo: string | undefined): string {
  if (!returnTo || !returnTo.startsWith("/")) return "/settings";
  return returnTo;
}

function withOAuthStatus(path: string, params: { status: string; provider: OAuthProvider; message?: string }): string {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("oauth_status", params.status);
  url.searchParams.set("oauth_provider", params.provider);
  if (params.message) url.searchParams.set("oauth_message", params.message);
  return `${url.pathname}${url.search}${url.hash}`;
}

export default function ProviderOAuthCallbackPage() {
  const completeProviderOAuth = useAction(api.providerConnections.completeProviderOAuth);
  const params = useParams<{ provider: string }>();
  const searchParams = useSearchParams();
  const hasRunRef = useRef(false);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Finalizing provider connection...");

  useEffect(() => {
    if (hasRunRef.current) return;
    hasRunRef.current = true;

    const provider = asProvider(params.provider);
    const error = searchParams.get("error");
    const errorDescription = searchParams.get("error_description");
    const code = searchParams.get("code");
    const state = searchParams.get("state");

    if (!provider) {
      setStatus("error");
      setMessage("Unsupported OAuth provider.");
      return;
    }

    if (error) {
      setStatus("error");
      setMessage(errorDescription || error);
      return;
    }

    if (!code || !state) {
      setStatus("error");
      setMessage("Missing OAuth code or state.");
      return;
    }

    const run = async () => {
      try {
        const result = await completeProviderOAuth({
          provider,
          code,
          state,
        });
        const returnTo = sanitizeReturnTo(result.returnTo);
        const redirectTo = withOAuthStatus(returnTo, {
          status: "success",
          provider,
        });
        setStatus("success");
        setMessage(`${provider === "gitlab" ? "GitLab" : "Bitbucket"} connected. Redirecting...`);
        window.location.replace(redirectTo);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "OAuth callback failed";
        setStatus("error");
        setMessage(errorMessage);
      }
    };

    void run();
  }, [completeProviderOAuth, params.provider, searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Repository Integration Callback</CardTitle>
          <CardDescription>
            Completing secure OAuth connection for provider access.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === "loading" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{message}</span>
            </div>
          )}
          {status === "success" && (
            <div className="flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              <span>{message}</span>
            </div>
          )}
          {status === "error" && (
            <>
              <div className="flex items-start gap-2 text-sm text-red-700">
                <AlertTriangle className="h-4 w-4 mt-0.5" />
                <span>{message}</span>
              </div>
              <Button asChild>
                <Link href="/settings">Back to Settings</Link>
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
