import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: true,
    coverage: {
      provider: "v8",
      include: [
        "src/api/auth.ts",
        "src/api/routes.ts",
        "src/gates/gateRunner.ts",
        "src/gates/memoryGate.ts",
        "src/gates/typecheckGate.ts",
        "src/lib/callbackAuth.ts",
        "src/lib/diffComputer.ts",
        "src/lib/diffFilter.ts",
        "src/lib/execFileAsync.ts",
        "src/lib/feedbackFormatter.ts",
        "src/lib/receiptNormalization.ts",
        "src/lib/repoProviderAuth.ts",
        "src/lib/resultParser.ts",
        "src/lib/shellSanitize.ts",
        "src/lib/timeout.ts",
        "src/queue/jobProcessor.ts",
        "src/vm/dnsPolicy.ts",
        "src/vm/egressProxy.ts",
        "src/workspace/heartbeat.ts",
        "src/workspace/recovery.ts",
        "src/workspace/validation.ts",
      ],
      exclude: ["src/**/*.test.ts", "dist/**"],
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 80,
      },
    },
  },
});
