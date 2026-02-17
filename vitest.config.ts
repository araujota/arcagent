import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environmentMatchGlobs: [
      ["convex/**", "edge-runtime"],
      ["src/**", "jsdom"],
    ],
    server: { deps: { inline: ["convex-test"] } },
    globals: true,
    setupFiles: ["src/__tests__/setup.ts"],
    include: ["convex/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
    // convex-test limitation: ctx.scheduler.runAfter() fires writes after the
    // transaction completes, producing harmless "Write outside of transaction"
    // rejections. Suppress them so they don't fail the suite.
    onUnhandledError(error) {
      if (error.message?.includes("Write outside of transaction")) {
        return false;
      }
    },
    coverage: {
      provider: "v8",
      include: ["convex/**/*.ts", "src/components/**/*.{ts,tsx}"],
      exclude: ["convex/_generated/**", "**/*.test.*"],
      reporter: ["text", "lcov"],
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
