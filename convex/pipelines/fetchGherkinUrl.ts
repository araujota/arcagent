import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { validateGherkin } from "../lib/gherkinValidator";

/**
 * Fetch Gherkin content from a URL and validate it.
 * Supports GitHub raw URLs, GitLab raw URLs, etc.
 */
export const fetchGherkinUrl = internalAction({
  args: {
    url: v.string(),
  },
  handler: async (_ctx, args) => {
    // Basic URL validation
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(args.url);
    } catch {
      return {
        content: "",
        valid: false,
        errors: [{ line: 0, message: "Invalid URL" }],
        stats: { features: 0, scenarios: 0, steps: 0, tags: [] },
      };
    }

    // Only allow HTTPS
    if (parsedUrl.protocol !== "https:") {
      return {
        content: "",
        valid: false,
        errors: [{ line: 0, message: "Only HTTPS URLs are supported" }],
        stats: { features: 0, scenarios: 0, steps: 0, tags: [] },
      };
    }

    try {
      const response = await fetch(args.url, {
        headers: {
          Accept: "text/plain",
          "User-Agent": "arcagent",
        },
      });

      if (!response.ok) {
        return {
          content: "",
          valid: false,
          errors: [{ line: 0, message: `HTTP ${response.status}: ${response.statusText}` }],
          stats: { features: 0, scenarios: 0, steps: 0, tags: [] },
        };
      }

      const content = await response.text();

      // Limit size (1MB)
      if (content.length > 1_000_000) {
        return {
          content: "",
          valid: false,
          errors: [{ line: 0, message: "File too large (max 1MB)" }],
          stats: { features: 0, scenarios: 0, steps: 0, tags: [] },
        };
      }

      const validation = validateGherkin(content);

      return {
        content,
        valid: validation.valid,
        errors: validation.errors,
        stats: validation.stats,
      };
    } catch (error) {
      return {
        content: "",
        valid: false,
        errors: [{ line: 0, message: error instanceof Error ? error.message : "Fetch failed" }],
        stats: { features: 0, scenarios: 0, steps: 0, tags: [] },
      };
    }
  },
});
