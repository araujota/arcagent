import { SignUp } from "@clerk/nextjs";
import { AuthShell } from "@/components/auth/auth-shell";

export default function SignUpPage() {
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
      />
    </AuthShell>
  );
}
