// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock Convex hooks
const mockCreateBounty = vi.fn();
const mockCreateTestSuite = vi.fn();
const mockConnectRepo = vi.fn();

const mockTrackEvent = vi.fn();

// useMutation is called twice: first for bounties.create, then testSuites.create
let mutationCallCount = 0;
vi.mock("convex/react", () => ({
  useMutation: vi.fn(() => {
    mutationCallCount++;
    // First call is bounties.create, second is testSuites.create
    if (mutationCallCount % 2 === 1) return mockCreateBounty;
    return mockCreateTestSuite;
  }),
  useAction: vi.fn(() => mockConnectRepo),
  useQuery: vi.fn(() => null),
}));

vi.mock("@/lib/analytics", () => ({
  useProductAnalytics: () => mockTrackEvent,
}));

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child step components to simplify rendering
vi.mock("./step-basics", () => ({
  StepBasics: ({ data, onChange }: any) => (
    <div data-testid="step-basics">
      <input
        data-testid="title-input"
        value={data.title}
        onChange={(e) => onChange({ ...data, title: e.target.value })}
      />
      <input
        data-testid="description-input"
        value={data.description}
        onChange={(e) => onChange({ ...data, description: e.target.value })}
      />
      <input
        data-testid="reward-input"
        type="number"
        value={data.reward}
        onChange={(e) => onChange({ ...data, reward: Number(e.target.value) })}
      />
    </div>
  ),
}));

vi.mock("./step-tests", () => ({
  StepTests: ({ data, onChange }: any) => (
    <div data-testid="step-tests">
      <input
        data-testid="public-tests-input"
        value={data.publicTests}
        onChange={(e) => onChange({ ...data, publicTests: e.target.value })}
      />
    </div>
  ),
}));

vi.mock("./step-config", () => ({
  StepConfig: ({ data, onChange }: any) => (
    <div data-testid="step-config">
      <input
        data-testid="repo-url-input"
        value={data.repositoryUrl}
        onChange={(e) => onChange({ ...data, repositoryUrl: e.target.value })}
      />
    </div>
  ),
}));

vi.mock("./step-review", () => ({
  StepReview: ({ isCertified, onCertificationChange }: any) => (
    <div data-testid="step-review">
      <label>
        <input
          data-testid="certification-checkbox"
          type="checkbox"
          checked={isCertified}
          onChange={(e) => onCertificationChange(e.target.checked)}
        />
        I certify
      </label>
    </div>
  ),
}));

vi.mock("@/components/bounties/repo-status-badge", () => ({
  RepoStatusBadge: () => null,
}));

import { BountyWizard } from "./bounty-wizard";
import { toast } from "sonner";

describe("BountyWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationCallCount = 0;
    localStorage.clear();
  });

  it("renders 4-step indicator", () => {
    render(<BountyWizard />);
    // Step names appear in both step indicator and card title, so use getAllByText
    expect(screen.getAllByText("Task").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Checks").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Setup").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Review").length).toBeGreaterThanOrEqual(1);
  });

  it("renders step 0 (Task) by default", () => {
    render(<BountyWizard />);
    expect(screen.getByTestId("step-basics")).toBeDefined();
  });

  it("Next button disabled when title/description empty or reward < 50", () => {
    render(<BountyWizard />);
    const nextButton = screen.getByText("Next");
    expect(nextButton).toBeDisabled();
  });

  it("Next button enabled when basics are valid, advances to step 1", async () => {
    render(<BountyWizard />);

    // Fill in valid basics
    fireEvent.change(screen.getByTestId("title-input"), {
      target: { value: "Test Bounty" },
    });
    fireEvent.change(screen.getByTestId("description-input"), {
      target: { value: "A test description" },
    });
    fireEvent.change(screen.getByTestId("reward-input"), {
      target: { value: "100" },
    });

    const nextButton = screen.getByText("Next");
    expect(nextButton).not.toBeDisabled();

    fireEvent.click(nextButton);

    // Should now show step 1 (Checks)
    await waitFor(() => {
      expect(screen.getByTestId("step-tests")).toBeDefined();
    });
  });

  it("Back button disabled on step 0", () => {
    render(<BountyWizard />);
    const backButton = screen.getByText("Back");
    expect(backButton).toBeDisabled();
  });

  it("step 3 shows staged AI draft and draft creation actions", async () => {
    render(<BountyWizard />);

    // Fill valid basics and navigate to step 3
    fireEvent.change(screen.getByTestId("title-input"), {
      target: { value: "Test" },
    });
    fireEvent.change(screen.getByTestId("description-input"), {
      target: { value: "Desc" },
    });
    fireEvent.change(screen.getByTestId("reward-input"), {
      target: { value: "100" },
    });

    // Advance through steps
    fireEvent.click(screen.getByText("Next")); // step 0 -> 1
    await waitFor(() => screen.getByTestId("step-tests"));

    fireEvent.click(screen.getByText("Next")); // step 1 -> 2
    await waitFor(() => screen.getByTestId("step-config"));

    fireEvent.click(screen.getByText("Next")); // step 2 -> 3
    await waitFor(() => screen.getByTestId("step-review"));

    expect(screen.getByText("Start AI Draft")).toBeDefined();
    expect(screen.getByText("Create draft")).toBeDefined();
  });

  it("create draft stays available for Stripe drafts without certification", async () => {
    render(<BountyWizard />);

    // Navigate to review step
    fireEvent.change(screen.getByTestId("title-input"), {
      target: { value: "Test" },
    });
    fireEvent.change(screen.getByTestId("description-input"), {
      target: { value: "Desc" },
    });
    fireEvent.change(screen.getByTestId("reward-input"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => screen.getByTestId("step-tests"));
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => screen.getByTestId("step-config"));
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => screen.getByTestId("step-review"));

    // Stripe drafts do not require certification because they are not published yet.
    const publishButton = screen.getByText("Create draft");
    expect(publishButton).not.toBeDisabled();
  });

  it("successful submit calls createBounty and navigates", async () => {
    mockCreateBounty.mockResolvedValue("bounty-123");

    render(<BountyWizard />);

    // Fill basics and navigate to review
    fireEvent.change(screen.getByTestId("title-input"), {
      target: { value: "My Bounty" },
    });
    fireEvent.change(screen.getByTestId("description-input"), {
      target: { value: "Description here" },
    });
    fireEvent.change(screen.getByTestId("reward-input"), {
      target: { value: "200" },
    });
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => screen.getByTestId("step-tests"));
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => screen.getByTestId("step-config"));
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => screen.getByTestId("step-review"));

    fireEvent.click(screen.getByText("Create draft"));

    await waitFor(() => {
      expect(mockCreateBounty).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "My Bounty",
          description: "Description here",
          reward: 200,
          status: "draft",
        }),
      );
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/bounties/bounty-123");
    });

    expect(toast.success).toHaveBeenCalledWith("Draft saved. Next: fund escrow, then publish.");
  });

  it("failed submit shows error toast", async () => {
    mockCreateBounty.mockRejectedValue(new Error("Network error"));

    render(<BountyWizard />);

    // Fill basics and navigate to review
    fireEvent.change(screen.getByTestId("title-input"), {
      target: { value: "Bounty" },
    });
    fireEvent.change(screen.getByTestId("description-input"), {
      target: { value: "Desc" },
    });
    fireEvent.change(screen.getByTestId("reward-input"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => screen.getByTestId("step-tests"));
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => screen.getByTestId("step-config"));
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => screen.getByTestId("step-review"));

    fireEvent.click(screen.getByText("Create draft"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Network error");
    });
  });
});
