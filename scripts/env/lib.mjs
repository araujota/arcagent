import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, "../..");

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    input: options.input,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const status = result.status ?? 1;

  if (status !== 0 && !options.allowFailure) {
    throw new Error(
      `Command failed (${status}): ${command} ${args.join(" ")}`,
    );
  }

  return { stdout, stderr, status };
}

export function loadContract() {
  const contractPath = path.join(scriptDir, "env_contract.json");
  return JSON.parse(readFileSync(contractPath, "utf8"));
}

export function sanitizeEnvValue(value) {
  let cleaned = value;

  // Handle escaped newlines from Vercel env pull quirks.
  cleaned = cleaned.replace(/^\\n+/, "").replace(/\\n+$/, "");

  // Handle real newline artifacts.
  cleaned = cleaned.replace(/^\n+/, "").replace(/\n+$/, "");

  // Trim accidental surrounding whitespace only.
  cleaned = cleaned.trim();

  return cleaned;
}

function unquote(raw) {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }

  return raw;
}

export function parseDotenv(content, { sanitize = true } = {}) {
  const output = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const key = match[1];
    const rawValue = match[2] ?? "";
    const unquoted = unquote(rawValue);
    output[key] = sanitize ? sanitizeEnvValue(unquoted) : unquoted;
  }

  return output;
}

export function parseConvexEnvList(content) {
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const idx = line.indexOf("=");
    if (idx <= 0) {
      continue;
    }

    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
      env[key] = value;
    }
  }

  return env;
}

export function parseGhNameTable(output) {
  const names = new Set();

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const first = trimmed.split(/\s+/)[0];
    if (/^[A-Z][A-Z0-9_]*$/.test(first)) {
      names.add(first);
    }
  }

  return names;
}

export function buildWorkerGeneratedEnv(contract, pulledEnv) {
  const env = {};
  const sourceByKey = {};

  for (const key of contract.vercel_pull_keys_for_worker) {
    const value = pulledEnv[key];
    if (value) {
      env[key] = sanitizeEnvValue(value);
      sourceByKey[key] = "vercel";
    }
  }

  if (!env.CONVEX_HTTP_ACTIONS_URL && env.CONVEX_URL) {
    env.CONVEX_HTTP_ACTIONS_URL = env.CONVEX_URL.replace(/\.convex\.cloud(?=\/?$)/, ".convex.site");
    sourceByKey.CONVEX_HTTP_ACTIONS_URL = "derived";
  }

  for (const [key, value] of Object.entries(contract.worker.local_defaults)) {
    if (!env[key]) {
      env[key] = value;
      sourceByKey[key] = "default";
    }
  }

  const missingRequired = contract.worker.required_local.filter((key) => !env[key]);

  return { env, sourceByKey, missingRequired };
}

function quoteForEnv(value) {
  return JSON.stringify(value ?? "");
}

export function writeEnvFile(filePath, env, orderedKeys = [], header = []) {
  const keys = orderedKeys.length > 0
    ? orderedKeys.filter((key) => key in env)
    : Object.keys(env).sort();

  const lines = [];
  if (header.length > 0) {
    lines.push(...header.map((line) => `# ${line}`));
    lines.push("");
  }

  for (const key of keys) {
    lines.push(`${key}=${quoteForEnv(env[key])}`);
  }

  const body = `${lines.join("\n")}\n`;
  writeFileSync(filePath, body, { encoding: "utf8", mode: 0o600 });
  chmodSync(filePath, 0o600);
}

export function pullVercelEnv(environment) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "arcagent-vercel-"));
  const envPath = path.join(tempDir, `${environment}.env`);

  try {
    runCommand("npx", [
      "--yes",
      "vercel",
      "env",
      "pull",
      envPath,
      "--environment",
      environment,
      "--yes",
    ]);

    const content = readFileSync(envPath, "utf8");
    return parseDotenv(content, { sanitize: true });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function parseArgs(argv) {
  const args = new Set(argv);
  return {
    yes: args.has("--yes"),
    dryRun: args.has("--dry-run"),
    nonInteractive: args.has("--non-interactive"),
  };
}

export function detectGithubRepo() {
  const result = runCommand(
    "gh",
    ["repo", "view", "--json", "nameWithOwner"],
    { allowFailure: true },
  );

  if (result.status !== 0 || !result.stdout.trim()) {
    return null;
  }

  try {
    const payload = JSON.parse(result.stdout);
    return payload.nameWithOwner ?? null;
  } catch {
    return null;
  }
}

export function listGithubSecretAndVariableNames(repo) {
  if (!repo) {
    return new Set();
  }

  const names = new Set();

  const secretResult = runCommand(
    "gh",
    ["secret", "list", "--repo", repo],
    { allowFailure: true },
  );
  for (const name of parseGhNameTable(secretResult.stdout)) {
    names.add(name);
  }

  const variableResult = runCommand(
    "gh",
    ["variable", "list", "--repo", repo],
    { allowFailure: true },
  );
  for (const name of parseGhNameTable(variableResult.stdout)) {
    names.add(name);
  }

  return names;
}

export async function promptHidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive prompt requires a TTY");
  }

  process.stdout.write(question);

  const stdin = process.stdin;
  let value = "";

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };

    const onData = (chunk) => {
      const char = chunk.toString("utf8");

      if (char === "\u0003") {
        cleanup();
        reject(new Error("Interrupted by user"));
        return;
      }

      if (char === "\r" || char === "\n") {
        process.stdout.write("\n");
        cleanup();
        resolve(value);
        return;
      }

      if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
        return;
      }

      value += char;
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
