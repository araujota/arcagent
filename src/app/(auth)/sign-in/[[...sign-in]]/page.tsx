import { SignIn } from "@clerk/nextjs";
import { AuthShell } from "@/components/auth/auth-shell";

export default function SignInPage() {
  return (
    <AuthShell
      eyebrow="Sign In"
      title="Pick up where you left off."
      description="Access your bounties, verification runs, payout setup, and API keys from the same workspace."
      alternateHref="/sign-up"
      alternateLabel="Create one here"
      alternateText="Need a new account?"
    >
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
      />
    </AuthShell>
  );
}
