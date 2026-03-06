// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("convex/react", () => ({
  useMutation: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    waitlist: {
      join: "waitlist:join",
      count: "waitlist:count",
    },
  },
}));

import { useMutation, useQuery } from "convex/react";
import { WaitlistForm } from "./waitlist-form";

const mockUseMutation = useMutation as ReturnType<typeof vi.fn>;
const mockUseQuery = useQuery as ReturnType<typeof vi.fn>;

describe("WaitlistForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue(3);
  });

  it("submits email and shows success state", async () => {
    const joinMock = vi.fn().mockResolvedValue({ status: "success" });
    mockUseMutation.mockReturnValue(joinMock);

    render(<WaitlistForm source="hero" />);

    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Get Updates" }));

    await waitFor(() => {
      expect(joinMock).toHaveBeenCalledWith({
        email: "test@example.com",
        source: "hero",
      });
    });

    expect(
      screen.getByText("You're subscribed. We'll send product updates here.")
    ).toBeInTheDocument();
  });

  it("shows duplicate message when email already exists", async () => {
    const joinMock = vi.fn().mockResolvedValue({ status: "duplicate" });
    mockUseMutation.mockReturnValue(joinMock);

    render(<WaitlistForm source="cta" />);

    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Get Updates" }));

    await waitFor(() => {
      expect(joinMock).toHaveBeenCalled();
    });

    expect(
      screen.getByText("You're already subscribed to product updates.")
    ).toBeInTheDocument();
  });
});
