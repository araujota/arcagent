import { describe, it, expect } from "vitest";
import {
  sanitizeShellArg,
  validateShellArg,
  sanitizeFilePath,
} from "./shellSanitize";

// ---------------------------------------------------------------------------
// sanitizeShellArg — repoUrl pattern
// ---------------------------------------------------------------------------

describe("sanitizeShellArg with repoUrl", () => {
  it("accepts a valid GitHub HTTPS URL", () => {
    const result = sanitizeShellArg(
      "https://github.com/owner/repo",
      "repoUrl",
      "repo URL",
    );
    expect(result).toBe("'https://github.com/owner/repo'");
  });

  it("accepts a .git suffix", () => {
    const result = sanitizeShellArg(
      "https://github.com/owner/repo.git",
      "repoUrl",
      "repo URL",
    );
    expect(result).toBe("'https://github.com/owner/repo.git'");
  });

  it("rejects non-HTTPS (http://)", () => {
    expect(() =>
      sanitizeShellArg("http://github.com/owner/repo", "repoUrl", "repo URL"),
    ).toThrow("Invalid repo URL");
  });

  it("accepts GitLab repository URLs (including nested groups)", () => {
    const result = sanitizeShellArg(
      "https://gitlab.com/group/subgroup/repo",
      "repoUrl",
      "repo URL",
    );
    expect(result).toBe("'https://gitlab.com/group/subgroup/repo'");
  });

  it("accepts Bitbucket repository URLs", () => {
    const result = sanitizeShellArg(
      "https://bitbucket.org/workspace/repo",
      "repoUrl",
      "repo URL",
    );
    expect(result).toBe("'https://bitbucket.org/workspace/repo'");
  });

  it("rejects URLs with semicolons", () => {
    expect(() =>
      sanitizeShellArg(
        "https://github.com/owner/repo;rm -rf /",
        "repoUrl",
        "repo URL",
      ),
    ).toThrow("Invalid repo URL");
  });

  it("rejects URLs with pipes", () => {
    expect(() =>
      sanitizeShellArg(
        "https://github.com/owner/repo|cat /etc/passwd",
        "repoUrl",
        "repo URL",
      ),
    ).toThrow("Invalid repo URL");
  });

  it("rejects URLs with backticks", () => {
    expect(() =>
      sanitizeShellArg(
        "https://github.com/owner/`whoami`",
        "repoUrl",
        "repo URL",
      ),
    ).toThrow("Invalid repo URL");
  });

  it("rejects SSH URLs (git@github.com:...)", () => {
    expect(() =>
      sanitizeShellArg(
        "git@github.com:owner/repo.git",
        "repoUrl",
        "repo URL",
      ),
    ).toThrow("Invalid repo URL");
  });

  it("accepts credentialed provider clone URLs for repoCloneUrl", () => {
    const githubClone = sanitizeShellArg(
      "https://x-access-token:ghs_token@github.com/owner/repo.git",
      "repoCloneUrl",
      "repo URL",
    );
    expect(githubClone).toBe("'https://x-access-token:ghs_token@github.com/owner/repo.git'");

    const gitlabClone = sanitizeShellArg(
      "https://oauth2:glpat-token@gitlab.com/group/repo.git",
      "repoCloneUrl",
      "repo URL",
    );
    expect(gitlabClone).toBe("'https://oauth2:glpat-token@gitlab.com/group/repo.git'");

    const bitbucketClone = sanitizeShellArg(
      "https://x-token-auth:bb_token@bitbucket.org/workspace/repo.git",
      "repoCloneUrl",
      "repo URL",
    );
    expect(bitbucketClone).toBe("'https://x-token-auth:bb_token@bitbucket.org/workspace/repo.git'");
  });
});

// ---------------------------------------------------------------------------
// sanitizeShellArg — commitSha pattern
// ---------------------------------------------------------------------------

describe("sanitizeShellArg with commitSha", () => {
  it("accepts a 7-char hex SHA", () => {
    const result = sanitizeShellArg("abc1234", "commitSha", "commit SHA");
    expect(result).toBe("'abc1234'");
  });

  it("accepts a 40-char hex SHA", () => {
    const sha = "a".repeat(40);
    const result = sanitizeShellArg(sha, "commitSha", "commit SHA");
    expect(result).toBe(`'${sha}'`);
  });

  it("rejects fewer than 7 chars", () => {
    expect(() =>
      sanitizeShellArg("abc12", "commitSha", "commit SHA"),
    ).toThrow("Invalid commit SHA");
  });

  it("rejects more than 40 chars", () => {
    expect(() =>
      sanitizeShellArg("a".repeat(41), "commitSha", "commit SHA"),
    ).toThrow("Invalid commit SHA");
  });

  it("rejects non-hex characters", () => {
    expect(() =>
      sanitizeShellArg("xyz1234", "commitSha", "commit SHA"),
    ).toThrow("Invalid commit SHA");
  });
});

// ---------------------------------------------------------------------------
// sanitizeShellArg — filePath pattern
// ---------------------------------------------------------------------------

describe("sanitizeShellArg with filePath", () => {
  it("accepts normal paths like src/index.ts", () => {
    const result = sanitizeShellArg("src/index.ts", "filePath", "file path");
    expect(result).toBe("'src/index.ts'");
  });

  it("accepts @scope/pkg", () => {
    const result = sanitizeShellArg("@scope/pkg", "filePath", "file path");
    expect(result).toBe("'@scope/pkg'");
  });

  it("rejects backticks", () => {
    expect(() =>
      sanitizeShellArg("`whoami`", "filePath", "file path"),
    ).toThrow("Invalid file path");
  });

  it("rejects semicolons", () => {
    expect(() =>
      sanitizeShellArg("file;rm -rf /", "filePath", "file path"),
    ).toThrow("Invalid file path");
  });

  it("rejects pipes", () => {
    expect(() =>
      sanitizeShellArg("file|cat /etc/passwd", "filePath", "file path"),
    ).toThrow("Invalid file path");
  });
});

// ---------------------------------------------------------------------------
// validateShellArg — returns raw value (no wrapping)
// ---------------------------------------------------------------------------

describe("validateShellArg", () => {
  it("returns the raw value without single-quote wrapping", () => {
    const result = validateShellArg(
      "https://github.com/owner/repo",
      "repoUrl",
      "repo URL",
    );
    expect(result).toBe("https://github.com/owner/repo");
    expect(result).not.toContain("'");
  });

  it("throws for invalid values just like sanitizeShellArg", () => {
    expect(() =>
      validateShellArg("http://github.com/owner/repo", "repoUrl", "repo URL"),
    ).toThrow("Invalid repo URL");
  });
});

// ---------------------------------------------------------------------------
// sanitizeFilePath
// ---------------------------------------------------------------------------

describe("sanitizeFilePath", () => {
  it("returns single-quote wrapped path for a safe file path", () => {
    const result = sanitizeFilePath("src/components/App.tsx");
    expect(result).toBe("'src/components/App.tsx'");
  });

  it("returns null for a path containing unsafe characters", () => {
    expect(sanitizeFilePath("`whoami`")).toBeNull();
  });

  it("returns null for paths with semicolons", () => {
    expect(sanitizeFilePath("file;rm -rf /")).toBeNull();
  });

  it("returns null for paths with pipes", () => {
    expect(sanitizeFilePath("file|cat /etc/passwd")).toBeNull();
  });
});
