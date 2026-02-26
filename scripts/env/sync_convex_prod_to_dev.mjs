#!/usr/bin/env node
import {
  loadContract,
  parseArgs,
  parseConvexEnvList,
  runCommand,
} from "./lib.mjs";

function main() {
  const args = parseArgs(process.argv.slice(2));
  loadContract();

  if (!args.yes) {
    console.error("[convex-parity] Refusing to sync prod -> dev without --yes.");
    console.error("[convex-parity] This operation copies all production Convex env variables to dev.");
    process.exit(1);
  }

  const prodResult = runCommand("npx", ["convex", "env", "list", "--prod"]);
  const prodEnv = parseConvexEnvList(prodResult.stdout);

  const keys = Object.keys(prodEnv).sort();
  if (keys.length === 0) {
    console.error("[convex-parity] No production Convex env variables found.");
    process.exit(1);
  }

  const routingKeys = ["CONVEX_URL", "CONVEX_HTTP_ACTIONS_URL", "WORKER_API_URL"].filter((key) => key in prodEnv);
  if (routingKeys.length > 0) {
    console.log("[convex-parity] Cross-environment routing keys detected:");
    for (const key of routingKeys) {
      console.log(`- ${key}`);
    }
  }

  if (args.dryRun) {
    console.log(`[convex-parity] Dry run: would sync ${keys.length} keys from prod to dev.`);
    for (const key of keys) {
      console.log(`- ${key}`);
    }
    return;
  }

  const changed = [];
  for (const key of keys) {
    runCommand("npx", ["convex", "env", "set", key], {
      input: prodEnv[key],
    });
    changed.push(key);
  }

  console.log(`[convex-parity] Synced ${changed.length} keys from prod to dev.`);
  for (const key of changed) {
    console.log(`- ${key}`);
  }
}

main();
