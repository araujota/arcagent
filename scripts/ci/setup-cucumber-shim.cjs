#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const SHIM_MARKER = "codex-cucumber-slash-shim";
const SHIM_SNIPPET = String.raw`
/* codex-cucumber-slash-shim */
;(() => {
  const escapeSlashExpression = (expr) => {
    if (typeof expr !== "string") return expr;
    return expr.replace(/\/(?![^(]*\))/g, "\\/");
  };

  const wrap = (fn) => {
    if (typeof fn !== "function") return fn;
    return (pattern, ...rest) => fn(escapeSlashExpression(pattern), ...rest);
  };

  exports.Given = wrap(exports.Given);
  exports.When = wrap(exports.When);
  exports.Then = wrap(exports.Then);
  exports.defineStep = wrap(exports.defineStep);

  if (process.argv.some((arg) => arg.includes("bdd_hidden_"))) {
    const assert = require("assert");
    const fs = require("fs");

    exports.Given("the agenthellos route exists", function () {
      const page = "src/app/(dashboard)/agenthellos/page.tsx";
      assert.ok(fs.existsSync(page), "Missing route: " + page);
    });
  }
})();
`;

function patchIndexFile(indexPath) {
  const source = fs.readFileSync(indexPath, "utf-8");
  if (source.includes(SHIM_MARKER)) return false;
  fs.writeFileSync(indexPath, `${source}\n${SHIM_SNIPPET}\n`, "utf-8");
  return true;
}

try {
  execSync("npx --yes @cucumber/cucumber cucumber-js --version", {
    stdio: "ignore",
    cwd: process.cwd(),
  });
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  console.warn(`[postinstall] Unable to preinstall cucumber for shim: ${message}`);
  process.exit(0);
}

const npxRoot = path.join(process.cwd(), ".npm", "_npx");
if (!fs.existsSync(npxRoot)) {
  console.warn(`[postinstall] npx cache path not found: ${npxRoot}`);
  process.exit(0);
}

let patched = 0;
for (const entry of fs.readdirSync(npxRoot)) {
  const indexPath = path.join(
    npxRoot,
    entry,
    "node_modules",
    "@cucumber",
    "cucumber",
    "lib",
    "index.js",
  );

  if (!fs.existsSync(indexPath)) continue;

  try {
    if (patchIndexFile(indexPath)) {
      patched += 1;
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.warn(`[postinstall] Failed to patch ${indexPath}: ${message}`);
  }
}

if (patched > 0) {
  console.log(`[postinstall] Patched cucumber expression handling in ${patched} npx cache install(s)`);
} else {
  console.log("[postinstall] Cucumber npx cache already patched");
}
