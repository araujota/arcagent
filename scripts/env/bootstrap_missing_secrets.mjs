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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const contract = loadContract();
  const targets = contract.sensitive_keys_for_bootstrap;

  const resolved = {};
  const sourceByKey = {};

  const vercelProd = pullVercelEnv("production");
  for (const key of targets) {
    if (vercelProd[key]) {
      resolved[key] = sanitizeEnvValue(vercelProd[key]);
      sourceByKey[key] = "vercel:production";
    }
  }

  for (const key of targets) {
    if (resolved[key]) {
      continue;
    }

    const value = readConvexProdValue(key);
    if (value) {
      resolved[key] = value;
      sourceByKey[key] = "convex:prod";
    }
  }

  const repo = detectGithubRepo();
  const ghNames = listGithubSecretAndVariableNames(repo);

  const unresolved = targets.filter((key) => !resolved[key]);
  const discoveredOnly = unresolved.filter((key) => ghNames.has(key));

  if (discoveredOnly.length > 0) {
    console.log("[bootstrap-secrets] Keys discovered in GitHub metadata (values not readable via CLI):");
    for (const key of discoveredOnly) {
      console.log(`- ${key}`);
    }
  }

  if (args.dryRun) {
    console.log(`[bootstrap-secrets] Dry run: evaluated ${targets.length} keys.`);
    for (const key of targets) {
      console.log(`- ${key}: ${sourceByKey[key] ?? "unresolved"}`);
    }
    if (unresolved.length > 0) {
      console.log("[bootstrap-secrets] Unresolved keys would require secure prompt input:");
      for (const key of unresolved) {
        console.log(`- ${key}`);
      }
    }
    return;
  }

  if (unresolved.length > 0 && args.nonInteractive) {
    console.error("[bootstrap-secrets] Missing required values and --non-interactive was set:");
    for (const key of unresolved) {
      console.error(`- ${key}`);
    }
    process.exit(1);
  }

  for (const key of unresolved) {
    const value = await promptHidden(`[bootstrap-secrets] Enter value for ${key}: `);
    if (!value) {
      console.error(`[bootstrap-secrets] ${key} cannot be empty.`);
      process.exit(1);
    }

    resolved[key] = value;
    sourceByKey[key] = "operator:prompt";
  }

  for (const key of targets) {
    const value = resolved[key];
    if (!value) {
      console.error(`[bootstrap-secrets] Missing value for ${key}.`);
      process.exit(1);
    }

    runCommand("npx", ["convex", "env", "set", key, "--prod"], {
      input: value,
    });

    runCommand("npx", ["convex", "env", "set", key], {
      input: value,
    });

    console.log(`[bootstrap-secrets] ${key}: set in Convex prod+dev (${sourceByKey[key]}).`);
  }

  console.log("[bootstrap-secrets] Optional Vercel centralization checklist:");
  console.log("- For each key below, run `npx vercel env add <KEY> production` if you want Vercel as the source of truth.");
  for (const key of targets) {
    console.log(`- ${key}`);
  }
}

main().catch((err) => {
  console.error(`[bootstrap-secrets] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
