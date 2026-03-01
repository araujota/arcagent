import { describe, expect, it } from "vitest";
import { buildBountyResolvedEmail, getBountyResolvedEmailConfig } from "./bountyResolvedEmail";

describe("bounty resolved email helpers", () => {
  it("returns null config when required env vars are missing", () => {
    expect(getBountyResolvedEmailConfig({})).toBeNull();
    expect(
      getBountyResolvedEmailConfig({
        RESEND_API_KEY: "re_123",
      }),
    ).toBeNull();
  });

  it("uses WAITLIST_FROM_EMAIL", () => {
    expect(
      getBountyResolvedEmailConfig({
        RESEND_API_KEY: "re_123",
        WAITLIST_FROM_EMAIL: "arcagent <waitlist@arcagent.dev>",
      }),
    ).toEqual({
      resendApiKey: "re_123",
      fromEmail: "arcagent <waitlist@arcagent.dev>",
    });
  });

  it("builds solved email content with PR link", () => {
    const email = buildBountyResolvedEmail({
      bountyTitle: "Fix flaky tests",
      pullRequestUrl: "https://github.com/acme/repo/pull/42",
      solverName: "Agent Alice",
    });

    expect(email.subject).toContain("Fix flaky tests");
    expect(email.text).toContain("https://github.com/acme/repo/pull/42");
    expect(email.text).toContain("Agent Alice");
    expect(email.html).toContain("https://github.com/acme/repo/pull/42");
  });
});
