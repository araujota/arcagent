import { describe, it, expect } from "vitest";

describe("Repo Connection URL Validation (P2-1)", () => {
  // Regex extracted from convex/repoConnections.ts create mutation
  const isValidGitHubUrl = (url: string) =>
    /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(url);

  it("accepts valid GitHub HTTPS URLs", () => {
    expect(isValidGitHubUrl("https://github.com/owner/repo")).toBe(true);
    expect(isValidGitHubUrl("https://github.com/my-org/my-repo")).toBe(true);
    expect(isValidGitHubUrl("https://github.com/user.name/repo.name")).toBe(true);
    expect(isValidGitHubUrl("http://github.com/owner/repo")).toBe(true);
  });

  it("rejects GitLab URLs", () => {
    expect(isValidGitHubUrl("https://gitlab.com/owner/repo")).toBe(false);
  });

  it("rejects Bitbucket URLs", () => {
    expect(isValidGitHubUrl("https://bitbucket.org/owner/repo")).toBe(false);
  });

  it("rejects self-hosted URLs", () => {
    expect(isValidGitHubUrl("https://git.example.com/owner/repo")).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isValidGitHubUrl("not-a-url")).toBe(false);
    expect(isValidGitHubUrl("https://github.com/")).toBe(false);
    expect(isValidGitHubUrl("https://github.com/owner")).toBe(false);
  });
});
