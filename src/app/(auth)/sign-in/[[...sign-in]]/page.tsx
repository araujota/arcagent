import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { AuthFormGate } from "@/components/auth/auth-form-gate";

export default async function SignInPage() {
  const { userId } = await auth();

  if (userId) {
    redirect("/dashboard");
  }

  return (
    <AuthShell
      eyebrow="Sign In"
      title="Pick up where you left off."
      description="Access your bounties, verification runs, payout setup, and API keys from the same workspace."
      alternateHref="/sign-up"
      alternateLabel="Create one here"
      alternateText="Need a new account?"
    >
      <AuthFormGate mode="sign-in" />
    </AuthShell>
  );
}
