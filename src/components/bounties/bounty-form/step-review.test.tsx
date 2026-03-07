// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/shared/gherkin-editor", () => ({
  GherkinDisplay: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock("@/components/repos/repo-context-files-summary", () => ({
  RepoContextFilesSummary: () => <div>Repo context</div>,
}));

import { StepReview } from "./step-review";

describe("StepReview", () => {
  it("links the publish certification to the full legal documents", () => {
    render(
      <StepReview
        basics={{
          title: "Legal test bounty",
          description: "Confirm review links",
          reward: 100,
          rewardCurrency: "USD",
        }}
        tests={{ publicTests: "", hiddenTests: "" }}
        config={{
          paymentMethod: "stripe",
          deadline: "",
          repositoryUrl: "",
          tags: "",
          requiredTier: undefined,
        }}
        isCertified={false}
        onCertificationChange={() => {}}
      />,
    );

    expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute(
      "href",
      "/terms",
    );
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.getByRole("button", { name: "creator certification summary" })).toBeInTheDocument();
  });
});
