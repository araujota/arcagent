// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock Convex
vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
}));

// Mock Convex generated API
vi.mock("../../../convex/_generated/api", () => ({
  api: {
    activityFeed: {
      listRecent: "activityFeed:listRecent",
    },
  },
}));

// Mock shadcn/ui Card components
vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: any) => (
    <div data-testid="card" {...props}>
      {children}
    </div>
  ),
  CardContent: ({ children, ...props }: any) => (
    <div data-testid="card-content" {...props}>
      {children}
    </div>
  ),
}));

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Trophy: (props: any) => <svg data-testid="icon-trophy" {...props} />,
  UserCheck: (props: any) => <svg data-testid="icon-usercheck" {...props} />,
  CheckCircle: (props: any) => <svg data-testid="icon-checkcircle" {...props} />,
  DollarSign: (props: any) => <svg data-testid="icon-dollarsign" {...props} />,
  Star: (props: any) => <svg data-testid="icon-star" {...props} />,
}));

import { useQuery } from "convex/react";
const mockUseQuery = useQuery as ReturnType<typeof vi.fn>;

// Import component after mocking
import { LiveActivityFeed } from "./live-activity-feed";

describe("LiveActivityFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders loading skeleton when data is undefined", () => {
    mockUseQuery.mockReturnValue(undefined);
    const { container } = render(<LiveActivityFeed />);
    // Loading state shows animated pulse placeholders
    const pulseElements = container.querySelectorAll(".animate-pulse");
    expect(pulseElements.length).toBe(5);
  });

  it("renders empty state message when events array is empty", () => {
    mockUseQuery.mockReturnValue([]);
    render(<LiveActivityFeed />);
    expect(
      screen.getByText(
        "Activity will appear here as bounties are posted and resolved."
      )
    ).toBeInTheDocument();
  });

  it("renders bounty_posted event correctly", () => {
    mockUseQuery.mockReturnValue([
      {
        _id: "1",
        type: "bounty_posted",
        bountyTitle: "Fix Login Bug",
        amount: 200,
        createdAt: Date.now(),
      },
    ]);
    render(<LiveActivityFeed />);
    expect(
      screen.getByText("Fix Login Bug posted with $200 reward")
    ).toBeInTheDocument();
  });

  it("renders bounty_claimed event correctly", () => {
    mockUseQuery.mockReturnValue([
      {
        _id: "2",
        type: "bounty_claimed",
        bountyTitle: "Add Tests",
        actorName: "AgentSmith",
        createdAt: Date.now(),
      },
    ]);
    render(<LiveActivityFeed />);
    expect(
      screen.getByText("Add Tests claimed by AgentSmith")
    ).toBeInTheDocument();
  });

  it("renders bounty_resolved event correctly", () => {
    mockUseQuery.mockReturnValue([
      {
        _id: "3",
        type: "bounty_resolved",
        bountyTitle: "Refactor API",
        actorName: "AgentNeo",
        createdAt: Date.now(),
      },
    ]);
    render(<LiveActivityFeed />);
    expect(
      screen.getByText("Refactor API resolved by AgentNeo")
    ).toBeInTheDocument();
  });

  it("renders payout_sent event correctly", () => {
    mockUseQuery.mockReturnValue([
      {
        _id: "4",
        type: "payout_sent",
        bountyTitle: "Deploy Pipeline",
        amount: 97,
        createdAt: Date.now(),
      },
    ]);
    render(<LiveActivityFeed />);
    expect(
      screen.getByText("$97 paid out for Deploy Pipeline")
    ).toBeInTheDocument();
  });

  it("P0-5: renders agent_rated events without crashing", () => {
    mockUseQuery.mockReturnValue([
      {
        _id: "5",
        type: "agent_rated",
        bountyTitle: "Test Bounty",
        actorName: "TestAgent",
        createdAt: Date.now(),
      },
    ]);
    render(<LiveActivityFeed />);
    expect(
      screen.getByText("TestAgent rated for Test Bounty")
    ).toBeInTheDocument();
  });

  it("renders all 5 event types together", () => {
    mockUseQuery.mockReturnValue([
      {
        _id: "1",
        type: "bounty_posted",
        bountyTitle: "Posted Bounty",
        amount: 100,
        createdAt: Date.now(),
      },
      {
        _id: "2",
        type: "bounty_claimed",
        bountyTitle: "Claimed Bounty",
        actorName: "Agent1",
        createdAt: Date.now(),
      },
      {
        _id: "3",
        type: "bounty_resolved",
        bountyTitle: "Resolved Bounty",
        actorName: "Agent2",
        createdAt: Date.now(),
      },
      {
        _id: "4",
        type: "payout_sent",
        bountyTitle: "Payout Bounty",
        amount: 97,
        createdAt: Date.now(),
      },
      {
        _id: "5",
        type: "agent_rated",
        bountyTitle: "Rated Bounty",
        actorName: "Agent3",
        createdAt: Date.now(),
      },
    ]);
    const { container } = render(<LiveActivityFeed />);
    // All 5 event rows should render
    const rows = container.querySelectorAll("[style]");
    expect(rows.length).toBe(5);
  });

  it("handles missing optional fields with defaults", () => {
    mockUseQuery.mockReturnValue([
      {
        _id: "1",
        type: "bounty_posted",
        bountyTitle: "No Amount",
        createdAt: Date.now(),
        // amount is undefined
      },
      {
        _id: "2",
        type: "bounty_claimed",
        bountyTitle: "No Actor",
        createdAt: Date.now(),
        // actorName is undefined
      },
      {
        _id: "3",
        type: "payout_sent",
        bountyTitle: "Zero Amount",
        createdAt: Date.now(),
        // amount is undefined
      },
      {
        _id: "4",
        type: "agent_rated",
        bountyTitle: "No Actor Rated",
        createdAt: Date.now(),
        // actorName is undefined
      },
    ]);
    render(<LiveActivityFeed />);
    // bounty_posted without amount omits reward text
    expect(screen.getByText("No Amount posted")).toBeInTheDocument();
    // bounty_claimed without actorName falls back to "an agent"
    expect(
      screen.getByText("No Actor claimed by an agent")
    ).toBeInTheDocument();
    // payout_sent without amount defaults to 0
    expect(
      screen.getByText("$0 paid out for Zero Amount")
    ).toBeInTheDocument();
    // agent_rated without actorName falls back to "An agent"
    expect(
      screen.getByText("An agent rated for No Actor Rated")
    ).toBeInTheDocument();
  });

  it("shows relative timestamps", () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    mockUseQuery.mockReturnValue([
      {
        _id: "1",
        type: "bounty_posted",
        bountyTitle: "Old Event",
        amount: 50,
        createdAt: oneHourAgo,
      },
    ]);
    render(<LiveActivityFeed />);
    expect(screen.getByText("1h ago")).toBeInTheDocument();
  });

  it("shows 'just now' for very recent events", () => {
    mockUseQuery.mockReturnValue([
      {
        _id: "1",
        type: "bounty_posted",
        bountyTitle: "Recent Event",
        amount: 50,
        createdAt: Date.now(),
      },
    ]);
    render(<LiveActivityFeed />);
    expect(screen.getByText("just now")).toBeInTheDocument();
  });
});
