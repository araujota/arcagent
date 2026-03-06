// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConvexClientProvider } from "./providers";

const MockConvexReactClient = vi.hoisted(
  () => class MockConvexReactClient {}
);

vi.mock("convex/react", () => ({
  ConvexReactClient: MockConvexReactClient,
}));

vi.mock("convex/react-clerk", () => ({
  ConvexProviderWithClerk: ({
    children,
  }: {
    children: ReactNode;
    useAuth: unknown;
  }) => <div data-testid="convex-provider">{children}</div>,
}));

vi.mock("@clerk/nextjs", () => ({
  ClerkProvider: ({
    children,
    ...props
  }: {
    children: ReactNode;
    [key: string]: unknown;
  }) => (
    <div data-testid="clerk-provider" data-props={JSON.stringify(props)}>
      {children}
    </div>
  ),
  useAuth: vi.fn(),
}));

describe("ConvexClientProvider", () => {
  it("pins Clerk auth routes and dashboard redirects", () => {
    render(
      <ConvexClientProvider>
        <div>child</div>
      </ConvexClientProvider>
    );

    const props = JSON.parse(
      screen.getByTestId("clerk-provider").getAttribute("data-props") ?? "{}"
    );

    expect(props.signInUrl).toBe("/sign-in");
    expect(props.signUpUrl).toBe("/sign-up");
    expect(props.signInFallbackRedirectUrl).toBe("/dashboard");
    expect(props.signUpFallbackRedirectUrl).toBe("/dashboard");
    expect(props.signInForceRedirectUrl).toBe("/dashboard");
    expect(props.signUpForceRedirectUrl).toBe("/dashboard");
    expect(props.afterSignOutUrl).toBe("/");
    expect(screen.getByTestId("convex-provider")).toBeInTheDocument();
  });
});
