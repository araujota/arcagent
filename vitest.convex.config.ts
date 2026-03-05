import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environmentMatchGlobs: [["convex/**", "edge-runtime"]],
    server: { deps: { inline: ["convex-test"] } },
    globals: true,
    include: ["convex/**/*.test.ts"],
    onUnhandledError(error) {
      if (error.message?.includes("Write outside of transaction")) {
        return false;
      }
    },
    coverage: {
      provider: "v8",
      include: [
        "convex/agentStats.ts",
        "convex/attemptWorkers.ts",
        "convex/bountyClaims.ts",
        "convex/devWorkspaces.ts",
        "convex/platformStats.ts",
        "convex/testBounties.ts",
        "convex/verifications.ts",
        "convex/lib/bountyResolvedEmail.ts",
        "convex/lib/constantTimeEqual.ts",
        "convex/lib/fees.ts",
        "convex/lib/gherkinValidator.ts",
        "convex/lib/hmac.ts",
        "convex/lib/languageDetector.ts",
        "convex/lib/tierCalculation.ts",
        "convex/lib/waitlistEmail.ts",
        "convex/pipelines/dispatchVerification.ts",
      ],
      exclude: ["convex/_generated/**", "**/*.test.*"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage/convex",
      thresholds: {
        lines: 80,
      },
    },
  },
});
