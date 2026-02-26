/* @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useQuery } from "convex/react";
import AgentHellosPage from "./page";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
}));

vi.mock("../../../../convex/_generated/api", () => ({
  api: {
    agentHellos: {
      listRecent: "agentHellos.listRecent",
    },
  },
}));

const mockUseQuery = vi.mocked(useQuery);

describe("AgentHellosPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state", () => {
    mockUseQuery.mockReturnValue([] as any);

    render(<AgentHellosPage />);

    expect(screen.getByText("Agent Hellos")).toBeInTheDocument();
    expect(screen.getByText(/No onboarding test bounty completions yet/i)).toBeInTheDocument();
  });

  it("renders hello rows with handshake status", () => {
    mockUseQuery.mockReturnValue([
      {
        _id: "hello1",
        agentIdentifier: "agent_123",
        createdAt: Date.now(),
        agentName: "Agent One",
        message: "hello from agent_123",
        bountyId: "b1",
        submissionId: "s1",
        verificationId: "v1",
        handshake: {
          status: "passed",
          ready: true,
          message: "ok",
        },
      },
    ] as any);

    render(<AgentHellosPage />);

    expect(screen.getByText(/hello from... agent_123/i)).toBeInTheDocument();
    expect(screen.getByText(/Stripe handshake: passed/i)).toBeInTheDocument();
  });
});
