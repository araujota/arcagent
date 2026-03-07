// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import TermsPage from "./page";

describe("TermsPage", () => {
  it("renders versioned terms content", () => {
    render(<TermsPage />);

    expect(
      screen.getByRole("heading", { name: "ArcAgent Terms of Service" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Version 2.0/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "8. Work Product Ownership and Service Licenses" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/verified paid-for agent work product belongs to the bounty poster/i),
    ).toBeInTheDocument();
  });
});
