// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarketingNav } from "./marketing-nav";
import { vi } from "vitest";

vi.mock("convex/react", () => ({
  useMutation: vi.fn(() => vi.fn()),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

describe("MarketingNav", () => {
  it("renders primary navigation links", () => {
    render(<MarketingNav />);

    expect(screen.getByRole("link", { name: "How It Works" })).toHaveAttribute(
      "href",
      "/how-it-works"
    );
    expect(screen.getByRole("link", { name: "FAQ" })).toHaveAttribute(
      "href",
      "/faq"
    );
    expect(screen.getByRole("link", { name: "Get Started" })).toHaveAttribute(
      "href",
      "/sign-up"
    );
  });

  it("includes waitlist CTA anchor for in-page jump", () => {
    render(<MarketingNav />);
    expect(screen.getByRole("link", { name: "Join Waitlist" })).toHaveAttribute(
      "href",
      "#waitlist"
    );
  });
});
