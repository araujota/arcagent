// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BountyCard } from "./bounty-card";

// Mock next/link
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// Mock BountyStatusBadge
vi.mock("@/components/bounties/bounty-status-badge", () => ({
  BountyStatusBadge: ({ status }: { status: string }) => (
    <span data-testid="bounty-status-badge">{status}</span>
  ),
}));

// Mock TierBadge
vi.mock("@/components/shared/tier-badge", () => ({
  TierBadge: ({ tier }: { tier: string }) => (
    <span data-testid="tier-badge">{tier}</span>
  ),
}));

// Mock Badge
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: any) => (
    <span data-testid="badge" {...props}>
      {children}
    </span>
  ),
}));

// Mock Card components
vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: any) => (
    <div data-testid="card" {...props}>
      {children}
    </div>
  ),
  CardHeader: ({ children, ...props }: any) => (
    <div data-testid="card-header" {...props}>
      {children}
    </div>
  ),
  CardTitle: ({ children, ...props }: any) => (
    <div data-testid="card-title" {...props}>
      {children}
    </div>
  ),
  CardContent: ({ children, ...props }: any) => (
    <div data-testid="card-content" {...props}>
      {children}
    </div>
  ),
  CardFooter: ({ children, ...props }: any) => (
    <div data-testid="card-footer" {...props}>
      {children}
    </div>
  ),
}));

const mockBounty = {
  _id: "bounty_123" as any,
  title: "Fix authentication bug",
  description: "Description here",
  status: "active" as const,
  reward: 150,
  rewardCurrency: "USD",
  tags: ["react", "typescript", "auth", "security", "next.js", "testing"],
  deadline: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days from now
  creator: { name: "John Creator", avatarUrl: null },
  _creationTime: Date.now(),
  creatorId: "user_456" as any,
};

describe("BountyCard", () => {
  it("renders bounty title and reward", () => {
    render(<BountyCard bounty={mockBounty as any} />);

    expect(screen.getByText("Fix authentication bug")).toBeInTheDocument();
    expect(screen.getByText("150 USD")).toBeInTheDocument();
  });

  it("renders status badge", () => {
    render(<BountyCard bounty={mockBounty as any} />);

    const badge = screen.getByTestId("bounty-status-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("active");
  });

  it("shows deadline when set", () => {
    render(<BountyCard bounty={mockBounty as any} />);

    // The deadline is 7 days from now, so it should show "7d left"
    expect(screen.getByText("7d left")).toBeInTheDocument();
  });

  it("renders tags with overflow", () => {
    render(<BountyCard bounty={mockBounty as any} />);

    // First 4 tags should be rendered
    expect(screen.getByText("react")).toBeInTheDocument();
    expect(screen.getByText("typescript")).toBeInTheDocument();
    expect(screen.getByText("auth")).toBeInTheDocument();
    expect(screen.getByText("security")).toBeInTheDocument();

    // Tags beyond the first 4 should not appear individually
    expect(screen.queryByText("next.js")).not.toBeInTheDocument();
    expect(screen.queryByText("testing")).not.toBeInTheDocument();

    // Overflow indicator should show "+2"
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("links to bounty detail page", () => {
    render(<BountyCard bounty={mockBounty as any} />);

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/bounties/bounty_123");
  });
});
