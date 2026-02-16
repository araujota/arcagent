import { describe, it, expect } from "vitest";
import { getVMConfig, getSupportedLanguages } from "./vmConfig";

describe("getVMConfig", () => {
  it("returns typescript config with correct rootfsImage, vCPUs, RAM", () => {
    const cfg = getVMConfig("typescript");
    expect(cfg.rootfsImage).toBe("node-20.ext4");
    expect(cfg.vcpuCount).toBe(2);
    expect(cfg.memSizeMib).toBe(1024);
  });

  it('"javascript" returns same config as "typescript" (alias)', () => {
    const ts = getVMConfig("typescript");
    const js = getVMConfig("javascript");
    expect(js).toEqual(ts);
  });

  it("returns correct config for python", () => {
    const cfg = getVMConfig("python");
    expect(cfg.rootfsImage).toBe("python-312.ext4");
    expect(cfg.vcpuCount).toBe(2);
    expect(cfg.memSizeMib).toBe(1024);
  });

  it("returns correct config for rust", () => {
    const cfg = getVMConfig("rust");
    expect(cfg.rootfsImage).toBe("rust-stable.ext4");
    expect(cfg.vcpuCount).toBe(4);
    expect(cfg.memSizeMib).toBe(2048);
  });

  it("returns correct config for go", () => {
    const cfg = getVMConfig("go");
    expect(cfg.rootfsImage).toBe("go-122.ext4");
  });

  it("returns correct config for java", () => {
    const cfg = getVMConfig("java");
    expect(cfg.rootfsImage).toBe("java-21.ext4");
    expect(cfg.vcpuCount).toBe(4);
    expect(cfg.memSizeMib).toBe(2048);
  });

  it("returns fallback config for unknown language", () => {
    const cfg = getVMConfig("brainfuck");
    expect(cfg.rootfsImage).toBe("base.ext4");
    expect(cfg.vcpuCount).toBe(2);
    expect(cfg.memSizeMib).toBe(512);
  });

  it('is case insensitive ("TypeScript" → typescript config)', () => {
    const cfg = getVMConfig("TypeScript");
    expect(cfg.rootfsImage).toBe("node-20.ext4");
  });

  it('trims whitespace ("  python  " → python config)', () => {
    const cfg = getVMConfig("  python  ");
    expect(cfg.rootfsImage).toBe("python-312.ext4");
  });

  it("all configs include COMMON_DOMAINS", () => {
    const commonDomains = [
      "github.com",
      "*.github.com",
      "objects.githubusercontent.com",
    ];
    for (const lang of getSupportedLanguages()) {
      const cfg = getVMConfig(lang);
      for (const domain of commonDomains) {
        expect(cfg.allowedDomains).toContain(domain);
      }
    }
  });

  it("all configs have vsockPort = 5000", () => {
    for (const lang of getSupportedLanguages()) {
      expect(getVMConfig(lang).vsockPort).toBe(5000);
    }
    // Also check fallback
    expect(getVMConfig("unknown").vsockPort).toBe(5000);
  });

  it("resource-heavy languages have ≥4 vCPUs and ≥2048 MiB", () => {
    const heavyLangs = ["rust", "cpp", "java", "csharp", "kotlin", "swift"];
    for (const lang of heavyLangs) {
      const cfg = getVMConfig(lang);
      expect(cfg.vcpuCount).toBeGreaterThanOrEqual(4);
      expect(cfg.memSizeMib).toBeGreaterThanOrEqual(2048);
    }
  });
});

describe("getSupportedLanguages", () => {
  it("returns all expected language keys", () => {
    const langs = getSupportedLanguages();
    const expected = [
      "typescript",
      "javascript",
      "python",
      "rust",
      "go",
      "java",
      "ruby",
      "php",
      "csharp",
      "c",
      "cpp",
      "swift",
      "kotlin",
    ];
    expect(langs).toEqual(expect.arrayContaining(expected));
    expect(langs).toHaveLength(expected.length);
  });
});
