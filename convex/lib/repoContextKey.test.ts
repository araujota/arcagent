import { describe, expect, it } from "vitest";
import { normalizeRepositoryForContext, isSupportedRepositoryUrlForContext } from "./repoContextKey";

describe("normalizeRepositoryForContext", () => {
  it("normalizes GitHub URLs", () => {
    const normalized = normalizeRepositoryForContext("https://github.com/Owner/MyRepo.git/");
    expect(normalized.repoKey).toBe("github:owner/myrepo");
    expect(normalized.repositoryUrlCanonical).toBe("https://github.com/owner/myrepo");
  });

  it("normalizes GitLab namespace paths", () => {
    const normalized = normalizeRepositoryForContext("https://gitlab.com/Group/SubGroup/Repo");
    expect(normalized.repoKey).toBe("gitlab:group/subgroup/repo");
    expect(normalized.namespace).toBe("group/subgroup");
    expect(normalized.repo).toBe("repo");
  });

  it("normalizes Bitbucket URLs", () => {
    const normalized = normalizeRepositoryForContext("https://bitbucket.org/Workspace/Repo");
    expect(normalized.repoKey).toBe("bitbucket:workspace/repo");
  });

  it("rejects unsupported hosts", () => {
    expect(() => normalizeRepositoryForContext("https://example.com/org/repo")).toThrow(
      /Unsupported repository host/,
    );
  });
});

describe("isSupportedRepositoryUrlForContext", () => {
  it("returns true for supported hosts", () => {
    expect(isSupportedRepositoryUrlForContext("https://github.com/org/repo")).toBe(true);
    expect(isSupportedRepositoryUrlForContext("https://gitlab.com/group/sub/repo")).toBe(true);
    expect(isSupportedRepositoryUrlForContext("https://bitbucket.org/workspace/repo")).toBe(true);
  });

  it("returns false for invalid URLs", () => {
    expect(isSupportedRepositoryUrlForContext("notaurl")).toBe(false);
    expect(isSupportedRepositoryUrlForContext("https://example.com/repo")).toBe(false);
  });
});
