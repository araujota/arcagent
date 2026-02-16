import { describe, it, expect } from "vitest";
import {
  parseAnalysisResponse,
  buildAnalysisUserContent,
} from "./analyzeRequirements";

// ---------------------------------------------------------------------------
// parseAnalysisResponse
// ---------------------------------------------------------------------------

describe("parseAnalysisResponse", () => {
  it("parses a ready=true response with summary and criteria", () => {
    const response = JSON.stringify({
      ready: true,
      scores: { actors: 3, inputs: 3, outputs: 2 },
      extractedCriteria: [
        "Criterion 1: Must validate email",
        "Criterion 2: Must return 201 on create",
      ],
      summary: "Requirements are clear enough to generate tests",
    });
    const result = parseAnalysisResponse(response);
    expect(result.ready).toBe(true);
    expect(result.summary).toContain("clear enough");
    expect(result.extractedCriteria).toHaveLength(2);
    expect(result.scores?.actors).toBe(3);
  });

  it("parses a ready=false response with questions", () => {
    const response = JSON.stringify({
      ready: false,
      scores: { actors: 1, inputs: 2 },
      extractedCriteria: ["Criterion 1: Inferred requirement"],
      questions: [
        {
          question: "Who are the target users?",
          reason: "Actors dimension scored 1",
          dimension: "actors",
        },
      ],
    });
    const result = parseAnalysisResponse(response);
    expect(result.ready).toBe(false);
    expect(result.questions).toHaveLength(1);
    expect(result.questions![0].dimension).toBe("actors");
  });

  it("parses fenced JSON (```json ... ```)", () => {
    const response = `\`\`\`json
{"ready": true, "summary": "All good", "extractedCriteria": []}
\`\`\``;
    const result = parseAnalysisResponse(response);
    expect(result.ready).toBe(true);
    expect(result.summary).toBe("All good");
  });

  it("returns fallback for malformed JSON", () => {
    const result = parseAnalysisResponse("This is not JSON at all.");
    expect(result.ready).toBe(false);
    expect(result.questions).toHaveLength(1);
    expect(result.questions![0].question).toContain("more details");
  });

  it("returns fallback for empty response", () => {
    const result = parseAnalysisResponse("");
    expect(result.ready).toBe(false);
    expect(result.questions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildAnalysisUserContent
// ---------------------------------------------------------------------------

describe("buildAnalysisUserContent", () => {
  it("always includes the description", () => {
    const content = buildAnalysisUserContent({
      description: "Build a REST API",
    });
    expect(content).toContain("## Feature Request");
    expect(content).toContain("Build a REST API");
  });

  it("includes requirements when provided", () => {
    const content = buildAnalysisUserContent({
      description: "test",
      requirements: "Must support pagination",
    });
    expect(content).toContain("## Additional Requirements");
    expect(content).toContain("Must support pagination");
  });

  it("includes repo context when provided", () => {
    const content = buildAnalysisUserContent({
      description: "test",
      repoContext: '{"repoMapText": "src/..."}',
    });
    expect(content).toContain("## Repository Context");
  });

  it("includes previous messages when provided", () => {
    const content = buildAnalysisUserContent({
      description: "test",
      previousMessages: "user: The API should handle JSON",
    });
    expect(content).toContain("## Previous Conversation");
    expect(content).toContain("The API should handle JSON");
  });

  it("omits optional sections when not provided", () => {
    const content = buildAnalysisUserContent({ description: "test" });
    expect(content).not.toContain("## Additional Requirements");
    expect(content).not.toContain("## Repository Context");
    expect(content).not.toContain("## Previous Conversation");
  });
});
