import { describe, it, expect } from "vitest";
import { validateWorkspacePath, isBlockedCommand } from "./validation";

// ---------------------------------------------------------------------------
// validateWorkspacePath
// ---------------------------------------------------------------------------

describe("validateWorkspacePath", () => {
  it("prepends /workspace/ to relative paths", () => {
    expect(validateWorkspacePath("src/index.ts")).toBe(
      "/workspace/src/index.ts",
    );
  });

  it("passes through an absolute /workspace/ path unchanged", () => {
    expect(validateWorkspacePath("/workspace/src/file.ts")).toBe(
      "/workspace/src/file.ts",
    );
  });

  it('throws for "../etc/passwd" (relative traversal)', () => {
    expect(() => validateWorkspacePath("../etc/passwd")).toThrow(
      "Path must be within /workspace/",
    );
  });

  it('throws for "/workspace/../etc/passwd"', () => {
    expect(() => validateWorkspacePath("/workspace/../etc/passwd")).toThrow(
      "Path must be within /workspace/",
    );
  });

  it('throws for "/etc/passwd" (absolute outside workspace)', () => {
    expect(() => validateWorkspacePath("/etc/passwd")).toThrow(
      "Path must be within /workspace/",
    );
  });

  it('throws for "/workspace/../../root" (double traversal)', () => {
    expect(() => validateWorkspacePath("/workspace/../../root")).toThrow(
      "Path must be within /workspace/",
    );
  });

  it('accepts "/workspace" itself', () => {
    expect(validateWorkspacePath("/workspace")).toBe("/workspace");
  });

  it("throws for deeply nested traversal escaping workspace", () => {
    expect(() =>
      validateWorkspacePath("/workspace/a/b/c/../../../../etc/shadow"),
    ).toThrow("Path must be within /workspace/");
  });
});

// ---------------------------------------------------------------------------
// isBlockedCommand
// ---------------------------------------------------------------------------

describe("isBlockedCommand", () => {
  it.each(["poweroff", "shutdown", "reboot", "halt", "init 0"])(
    'blocks exact command "%s"',
    (cmd) => {
      expect(isBlockedCommand(cmd)).toBe(true);
    },
  );

  it("blocks shutdown with arguments (shutdown now)", () => {
    expect(isBlockedCommand("shutdown now")).toBe(true);
  });

  it("blocks chained command with && (echo ok && poweroff)", () => {
    expect(isBlockedCommand("echo ok && poweroff")).toBe(true);
  });

  it("blocks semicolon-chained command (echo ok; reboot)", () => {
    expect(isBlockedCommand("echo ok; reboot")).toBe(true);
  });

  it("allows safe commands like echo hello", () => {
    expect(isBlockedCommand("echo hello")).toBe(false);
  });

  it("allows safe commands like npm run build", () => {
    expect(isBlockedCommand("npm run build")).toBe(false);
  });

  it("is case-insensitive via .toLowerCase()", () => {
    expect(isBlockedCommand("POWEROFF")).toBe(true);
    expect(isBlockedCommand("Shutdown")).toBe(true);
  });
});
