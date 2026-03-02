import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConvexEnvList, runCommand } from "./lib.mjs";

const argv = new Set(process.argv.slice(2));
const useProd = argv.has("--prod");

const convexArgs = ["convex", "env", "list"];
if (useProd) {
  convexArgs.push("--prod");
}

const { stdout } = runCommand("npx", convexArgs);
const convexEnv = parseConvexEnvList(stdout);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const libTestPath = path.join(scriptDir, "lib.test.mjs");
const smokeTestPath = path.join(scriptDir, "smoke_secrets.test.mjs");

const result = spawnSync(
  process.execPath,
  ["--test", libTestPath, smokeTestPath],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ...convexEnv,
    },
  },
);

process.exit(result.status ?? 1);
