import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/__tests__/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: [
        "src/components/bounties/bounty-card.tsx",
        "src/components/landing/live-activity-feed.tsx",
        "src/components/landing/marketing-nav.tsx",
        "src/components/landing/waitlist-form.tsx",
      ],
      exclude: ["**/*.test.*"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage/webui",
      thresholds: {
        lines: 80,
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
