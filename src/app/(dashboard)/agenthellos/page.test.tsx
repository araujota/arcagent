/* @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AgentHellosPage from "./page";

describe("AgentHellosPage", () => {
  it("renders a blank canvas container", () => {
    render(<AgentHellosPage />);

    expect(screen.getByTestId("agenthellos-canvas")).toBeInTheDocument();
  });
});
