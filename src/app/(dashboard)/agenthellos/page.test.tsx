/* @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AgentHellosPage from "./page";

describe("AgentHellosPage", () => {
  it("renders client-code-only shell", () => {
    render(<AgentHellosPage />);

    expect(screen.getByTestId("agenthellos-canvas")).toBeInTheDocument();
    expect(screen.getByText("Agent Hellos")).toBeInTheDocument();
    expect(screen.getByText(/Client-code feed from testbounty runs/i)).toBeInTheDocument();
  });

  it("renders local hello entry and docs link", () => {
    render(<AgentHellosPage />);

    expect(screen.getByText(/hello from/i)).toBeInTheDocument();
    expect(screen.getAllByText(/agentIdentifier/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /Open test bounty docs/i })).toHaveAttribute(
      "href",
      "/docs?tab=agent#agent-claiming-workflow",
    );
  });
});
