#!/usr/bin/env node
import { execSync } from "node:child_process";

const raw = execSync("npm pack --dry-run --json", {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const jsonStart = raw.indexOf("[");
if (jsonStart === -1) {
  throw new Error("Unable to parse npm pack --dry-run output");
}

const data = JSON.parse(raw.slice(jsonStart));
const files = data?.[0]?.files ?? [];
const bad = files.filter((entry) => /\.test\.(js|d\.ts)$/.test(entry.path));

if (bad.length > 0) {
  console.error("ERROR: test artifacts detected in package:");
  for (const file of bad) {
    console.error(` - ${file.path}`);
  }
  process.exit(1);
}

console.log(`Pack check passed (${files.length} files, no test artifacts).`);
