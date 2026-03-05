#!/usr/bin/env node
import {
  detectGithubRepo,
  listGithubSecretAndVariableNames,
  loadContract,
  parseArgs,
  promptHidden,
  pullVercelEnv,
  runCommand,
  sanitizeEnvValue,
} from "./lib.mjs";

function readConvexProdValue(key) {
  const result = runCommand(
    "npx",
    ["convex", "env", "get", key, "--prod"],
    { allowFailure: true },
  );

  if (result.status !== 0) {
    return null;
  }

  const value = result.stdout.replace(/[\r\n]+$/, "");
  if (!value) {
    return null;
  }

  return sanitizeEnvValue(value);
}

function hydrateResolvedFromVercel(targets, resolved, sourceByKey) {
  const vercelProd = pullVercelEnv("production");
  for (const key of targets) {
    if (!vercelProd[key]) continue;
    resolved[key] = sanitizeEnvValue(vercelProd[key]);
    sourceByKey[key] = "vercel:production";
  }
}

function hydrateResolvedFromConvex(targets, resolved, sourceByKey) {
  for (const key of targets) {
    if (resolved[key]) continue;
    const value = readConvexProdValue(key);
    if (!value) continue;
    resolved[key] = value;
    sourceByKey[key] = "convex:prod";
  }
}

function logDiscoveredOnlyKeys(discoveredOnly) {
  if (discoveredOnly.length === 0) return;
  console.log("[bootstrap-secrets] Keys discovered in GitHub metadata (values not readable via CLI):");
  for (const key of discoveredOnly) {
    console.log(`- ${key}`);
  }
}

function printDryRun(targets, sourceByKey, unresolved) {
  console.log(`[bootstrap-secrets] Dry run: evaluated ${targets.length} keys.`);
  for (const key of targets) {
    console.log(`- ${key}: ${sourceByKey[key] ?? "unresolved"}`);
  }
  if (unresolved.length === 0) return;
  console.log("[bootstrap-secrets] Unresolved keys would require secure prompt input:");
  for (const key of unresolved) {
    console.log(`- ${key}`);
  }
}

function failForNonInteractiveUnresolved(unresolved) {
  if (unresolved.length === 0) return;
  console.error("[bootstrap-secrets] Missing required values and --non-interactive was set:");
  for (const key of unresolved) {
    console.error(`- ${key}`);
  }
  process.exit(1);
}

async function promptForUnresolved(unresolved, resolved, sourceByKey) {
  for (const key of unresolved) {
    const value = await promptHidden(`[bootstrap-secrets] Enter value for ${key}: `);
    if (!value) {
      console.error(`[bootstrap-secrets] ${key} cannot be empty.`);
      process.exit(1);
    }
    resolved[key] = value;
    sourceByKey[key] = "operator:prompt";
  }
}

function assertAllValuesResolved(targets, resolved) {
  for (const key of targets) {
    if (resolved[key]) continue;
    console.error(`[bootstrap-secrets] Missing value for ${key}.`);
    process.exit(1);
  }
}

function setConvexValues(targets, resolved, sourceByKey) {
  for (const key of targets) {
    const value = resolved[key];
    runCommand("npx", ["convex", "env", "set", key, "--prod"], {
      input: value,
    });
    runCommand("npx", ["convex", "env", "set", key], {
      input: value,
    });
    console.log(`[bootstrap-secrets] ${key}: set in Convex prod+dev (${sourceByKey[key]}).`);
  }
}

function printOptionalVercelChecklist(targets) {
  console.log("[bootstrap-secrets] Optional Vercel centralization checklist:");
  console.log("- For each key below, run `npx vercel env add <KEY> production` if you want Vercel as the source of truth.");
  for (const key of targets) {
    console.log(`- ${key}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const contract = loadContract();
  const targets = contract.sensitive_keys_for_bootstrap;

  const resolved = {};
  const sourceByKey = {};

  hydrateResolvedFromVercel(targets, resolved, sourceByKey);
  hydrateResolvedFromConvex(targets, resolved, sourceByKey);

  const repo = detectGithubRepo();
  const ghNames = listGithubSecretAndVariableNames(repo);

  const unresolved = targets.filter((key) => !resolved[key]);
  const discoveredOnly = unresolved.filter((key) => ghNames.has(key));
  logDiscoveredOnlyKeys(discoveredOnly);

  if (args.dryRun) {
    printDryRun(targets, sourceByKey, unresolved);
    return;
  }

  if (args.nonInteractive) failForNonInteractiveUnresolved(unresolved);
  await promptForUnresolved(unresolved, resolved, sourceByKey);
  assertAllValuesResolved(targets, resolved);
  setConvexValues(targets, resolved, sourceByKey);
  printOptionalVercelChecklist(targets);
}

main().catch((err) => {
  console.error(`[bootstrap-secrets] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
