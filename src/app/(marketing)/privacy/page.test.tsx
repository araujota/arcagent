// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import PrivacyPage from "./page";

describe("PrivacyPage", () => {
  it("renders versioned privacy content", () => {
    render(<PrivacyPage />);

    expect(
      screen.getByRole("heading", { name: "ArcAgent Privacy Policy" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Version 2.0/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "6. Third-Party Services and Processors" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/ArcAgent currently uses or is designed to use third-party services visible in the product and codebase, including Clerk/i),
    ).toBeInTheDocument();
  });
});
