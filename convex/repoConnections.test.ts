import { describe, it, expect } from "vitest";
import { detectProvider } from "./lib/repoProviders";

describe("Repo Connection URL Validation", () => {
  it("detects valid GitHub HTTPS URLs", () => {
    expect(detectProvider("https://github.com/owner/repo")).toBe("github");
    expect(detectProvider("https://github.com/my-org/my-repo")).toBe("github");
    expect(detectProvider("https://github.com/user.name/repo.name")).toBe("github");
    expect(detectProvider("http://github.com/owner/repo")).toBe("github");
  });

  it("detects valid GitLab HTTPS URLs", () => {
    expect(detectProvider("https://gitlab.com/owner/repo")).toBe("gitlab");
    expect(detectProvider("https://gitlab.com/group/subgroup/repo")).toBe("gitlab");
  });

  it("detects valid Bitbucket HTTPS URLs", () => {
    expect(detectProvider("https://bitbucket.org/workspace/slug")).toBe("bitbucket");
  });

  it("detects SSH URLs", () => {
    expect(detectProvider("git@github.com:owner/repo.git")).toBe("github");
    expect(detectProvider("git@gitlab.com:owner/repo.git")).toBe("gitlab");
    expect(detectProvider("git@bitbucket.org:workspace/slug.git")).toBe("bitbucket");
  });

  it("rejects self-hosted URLs", () => {
    expect(detectProvider("https://git.example.com/owner/repo")).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(detectProvider("not-a-url")).toBeNull();
    expect(detectProvider("ftp://github.com/owner/repo")).toBeNull();
  });

  it("detects provider even for incomplete paths (parseUrl validates structure)", () => {
    // detectProvider only checks the domain — parseUrl throws for missing owner/repo
    expect(detectProvider("https://github.com/")).toBe("github");
    expect(detectProvider("https://github.com/owner")).toBe("github");
  });
});
