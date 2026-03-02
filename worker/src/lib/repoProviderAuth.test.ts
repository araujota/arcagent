import { describe, it, expect } from "vitest";
import {
  buildAuthenticatedCloneRepoUrl,
  detectRepoProvider,
  ensureParsedRepoRef,
  parseRepoRef,
  repoRefToPath,
} from "./repoProviderAuth";

describe("detectRepoProvider", () => {
  it("detects GitHub, GitLab, and Bitbucket URLs", () => {
    expect(detectRepoProvider("https://github.com/org/repo")).toBe("github");
    expect(detectRepoProvider("https://gitlab.com/group/sub/repo")).toBe("gitlab");
    expect(detectRepoProvider("https://bitbucket.org/workspace/repo")).toBe("bitbucket");
  });
});

describe("parseRepoRef", () => {
  it("parses GitLab subgroup URLs", () => {
    const parsed = parseRepoRef("https://gitlab.com/group/subgroup/repo.git");
    expect(parsed).toEqual({
      provider: "gitlab",
      namespace: "group/subgroup",
      repo: "repo",
    });
  });

  it("parses Bitbucket workspace repos", () => {
    const parsed = parseRepoRef("https://bitbucket.org/ws/repo");
    expect(parsed).toEqual({
      provider: "bitbucket",
      workspace: "ws",
      repo: "repo",
    });
  });

  it("returns null for unsupported URLs", () => {
    expect(parseRepoRef("https://example.com/org/repo")).toBeNull();
  });
});

describe("buildAuthenticatedCloneRepoUrl", () => {
  it("normalizes GitHub clone URL with credentials", () => {
    const clone = buildAuthenticatedCloneRepoUrl("https://github.com/org/repo", "ghs_token");
    expect(clone.url).toBe("https://x-access-token:ghs_token@github.com/org/repo.git");
  });

  it("builds GitLab OAuth clone URL", () => {
    const clone = buildAuthenticatedCloneRepoUrl("https://gitlab.com/group/repo", "glpat-token");
    expect(clone.url).toBe("https://oauth2:glpat-token@gitlab.com/group/repo.git");
  });

  it("builds Bitbucket username+token clone URL", () => {
    const clone = buildAuthenticatedCloneRepoUrl(
      "https://bitbucket.org/workspace/repo",
      "app_password",
      "my-user",
    );
    expect(clone.url).toBe("https://my-user:app_password@bitbucket.org/workspace/repo.git");
  });

  it("requires token for GitHub clones", () => {
    expect(() => buildAuthenticatedCloneRepoUrl("https://github.com/org/repo")).toThrow(
      "Missing repoAuthToken for GitHub repository clone",
    );
  });
});

describe("repo path helpers", () => {
  it("formats provider path consistently", () => {
    expect(repoRefToPath(ensureParsedRepoRef("https://github.com/org/repo"))).toBe("org/repo");
    expect(repoRefToPath(ensureParsedRepoRef("https://gitlab.com/group/repo"))).toBe("group/repo");
    expect(repoRefToPath(ensureParsedRepoRef("https://bitbucket.org/ws/repo"))).toBe("ws/repo");
  });
});
