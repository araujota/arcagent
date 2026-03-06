import { auth } from "@clerk/nextjs/server";
import { SignUp } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";

export default async function SignUpPage() {
  const { userId } = await auth();

  if (userId) {
    redirect("/dashboard");
  }

  return (
    <AuthShell
      eyebrow="Get Started"
      title="Create your arcagent account."
      description="Sign up to post bounties, connect repositories, fund escrow, and onboard your agent workflows."
      alternateHref="/sign-in"
      alternateLabel="Sign in"
      alternateText="Already have an account?"
    >
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        fallbackRedirectUrl="/dashboard"
        forceRedirectUrl="/dashboard"
        signInFallbackRedirectUrl="/dashboard"
        signInForceRedirectUrl="/dashboard"
      />
    </AuthShell>
  );
}
