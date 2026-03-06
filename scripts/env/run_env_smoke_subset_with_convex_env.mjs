import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConvexEnvList, runCommand } from "./lib.mjs";

const argv = process.argv.slice(2);
const useProd = argv.includes("--prod");
const patternIndex = argv.indexOf("--pattern");
const pattern = patternIndex >= 0 ? argv[patternIndex + 1] : null;

if (!pattern) {
  console.error("Usage: node scripts/env/run_env_smoke_subset_with_convex_env.mjs --pattern <regex> [--prod]");
  process.exit(1);
}

const convexArgs = ["convex", "env", "list"];
if (useProd) {
  convexArgs.push("--prod");
}

const { stdout } = runCommand("npx", convexArgs);
const convexEnv = parseConvexEnvList(stdout);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const smokeTestPath = path.join(scriptDir, "smoke_secrets.test.mjs");

const result = spawnSync(
  process.execPath,
  ["--test", "--test-name-pattern", pattern, smokeTestPath],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ...convexEnv,
    },
  },
);

process.exit(result.status ?? 1);
