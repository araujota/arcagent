// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

process.env.NEXT_PUBLIC_ENABLE_REPO_CONTEXT_FILES = "true";

import { RepoContextFilesManager } from "./repo-context-files-manager";

describe("RepoContextFilesManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue(vi.fn());
  });

  it("shows helper text when repository URL is invalid", () => {
    render(<RepoContextFilesManager repositoryUrl="invalid" />);
    expect(screen.getByText(/Add a valid GitHub, GitLab, or Bitbucket URL/i)).toBeDefined();
  });

  it("renders existing files when query returns rows", () => {
    mockUseQuery.mockReturnValue([
      {
        _id: "ctx_1",
        filenameOriginal: "CONTRIBUTING.md",
        bytes: 1200,
        extractionStatus: "ready",
        createdAt: Date.now(),
      },
    ]);

    render(<RepoContextFilesManager repositoryUrl="https://github.com/acme/repo" readOnly />);
    expect(screen.getByText("CONTRIBUTING.md")).toBeDefined();
    expect(screen.getByText("ready")).toBeDefined();
  });
});
