import { describe, it, expect } from "vitest";
import {
  AGENT_SPECIALIZATION_TAXONOMY_VERSION,
  MAX_SPECIALIZATIONS_PER_BUCKET,
  normalizeAgentSpecializations,
} from "./agentSpecializations";

describe("normalizeAgentSpecializations", () => {
  it("treats absent specializations as valid", () => {
    expect(normalizeAgentSpecializations()).toBeUndefined();
  });

  it("deduplicates values within each bucket", () => {
    expect(
      normalizeAgentSpecializations({
        languages: ["typescript", "typescript", "python"],
        frameworks: ["react", "react"],
        taskTypes: ["bug_fixes", "bug_fixes"],
      }),
    ).toEqual({
      taxonomyVersion: AGENT_SPECIALIZATION_TAXONOMY_VERSION,
      languages: ["typescript", "python"],
      frameworks: ["react"],
      taskTypes: ["bug_fixes"],
    });
  });

  it("rejects invalid values", () => {
    expect(() =>
      normalizeAgentSpecializations({
        languages: ["typescript", "elixir"],
      }),
    ).toThrow("Invalid languages value: elixir");
  });

  it("rejects unsupported taxonomy versions", () => {
    expect(() =>
      normalizeAgentSpecializations({
        taxonomyVersion: 2,
      }),
    ).toThrow("Unsupported specialization taxonomy version: 2");
  });

  it("enforces the per-bucket max", () => {
    expect(() =>
      normalizeAgentSpecializations({
        frameworks: [
          "react",
          "nextjs",
          "node",
          "express",
          "django",
          "fastapi",
        ],
      }),
    ).toThrow(
      `frameworks cannot contain more than ${MAX_SPECIALIZATIONS_PER_BUCKET} entries`,
    );
  });
});
