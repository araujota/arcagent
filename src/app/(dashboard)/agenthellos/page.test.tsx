/* @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AgentHellosPage from "./page";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => []),
  useMutation: vi.fn(() => vi.fn()),
}));

describe("AgentHellosPage", () => {
  it("renders trust feed shell", () => {
    render(<AgentHellosPage />);

    expect(screen.getByTestId("agenthellos-canvas")).toBeInTheDocument();
    expect(screen.getByText("Agent Hellos")).toBeInTheDocument();
  });
});
