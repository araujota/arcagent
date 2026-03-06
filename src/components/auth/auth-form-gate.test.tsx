// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthFormGate } from "./auth-form-gate";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  userId: null as string | null,
}));

const replace = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace,
  }),
}));

vi.mock("@clerk/nextjs", () => ({
  SignIn: (props: Record<string, string>) => (
    <div
      data-testid="clerk-sign-in"
      data-path={props.path}
      data-sign-up-url={props.signUpUrl}
      data-fallback-url={props.fallbackRedirectUrl}
      data-force-url={props.forceRedirectUrl}
    />
  ),
  SignUp: (props: Record<string, string>) => (
    <div
      data-testid="clerk-sign-up"
      data-path={props.path}
      data-sign-in-url={props.signInUrl}
      data-fallback-url={props.fallbackRedirectUrl}
      data-force-url={props.forceRedirectUrl}
    />
  ),
  useAuth: () => clerkState,
}));

describe("AuthFormGate", () => {
  beforeEach(() => {
    clerkState.isLoaded = true;
    clerkState.userId = null;
    replace.mockReset();
  });

  it("shows a loading state until Clerk finishes hydrating", () => {
    clerkState.isLoaded = false;

    render(<AuthFormGate mode="sign-in" />);

    expect(screen.getByText("Checking your session...")).toBeInTheDocument();
    expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();
  });

  it("redirects signed-in users before rendering Clerk sign-in", async () => {
    clerkState.userId = "user_123";

    render(<AuthFormGate mode="sign-in" />);

    expect(
      screen.getByText("Redirecting to your dashboard...")
    ).toBeInTheDocument();
    expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/dashboard");
    });
  });

  it("renders sign-in with dashboard redirects for signed-out users", () => {
    render(<AuthFormGate mode="sign-in" />);

    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-path",
      "/sign-in"
    );
    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-sign-up-url",
      "/sign-up"
    );
    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-fallback-url",
      "/dashboard"
    );
    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-force-url",
      "/dashboard"
    );
  });

  it("renders sign-up with dashboard redirects for signed-out users", () => {
    render(<AuthFormGate mode="sign-up" />);

    expect(screen.getByTestId("clerk-sign-up")).toHaveAttribute(
      "data-path",
      "/sign-up"
    );
    expect(screen.getByTestId("clerk-sign-up")).toHaveAttribute(
      "data-sign-in-url",
      "/sign-in"
    );
    expect(screen.getByTestId("clerk-sign-up")).toHaveAttribute(
      "data-fallback-url",
      "/dashboard"
    );
    expect(screen.getByTestId("clerk-sign-up")).toHaveAttribute(
      "data-force-url",
      "/dashboard"
    );
  });
});
