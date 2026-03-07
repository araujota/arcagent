import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkerGeneratedEnv,
  deriveConvexSiteUrl,
  parseConvexEnvList,
  parseDotenv,
  parseGhNameTable,
  sanitizeEnvValue,
} from "./lib.mjs";

test("sanitizeEnvValue trims whitespace and escaped newline artifacts", () => {
  assert.equal(sanitizeEnvValue("\\nsecret-value\\n"), "secret-value");
  assert.equal(sanitizeEnvValue("\n value \n"), "value");
});

test("parseDotenv handles quoted values and preserves equals in value", () => {
  const parsed = parseDotenv([
    'CLERK_SECRET_KEY="sk_test_abc"',
    'WORKER_SHARED_SECRET="\\nabc123\\n"',
    "A_B_C=plain",
    "# comment",
    "",
  ].join("\n"));

  assert.equal(parsed.CLERK_SECRET_KEY, "sk_test_abc");
  assert.equal(parsed.WORKER_SHARED_SECRET, "abc123");
  assert.equal(parsed.A_B_C, "plain");
});

test("parseConvexEnvList handles values containing equals", () => {
  const parsed = parseConvexEnvList([
    "STRIPE_WEBHOOK_SECRET=whsec_abc=def",
    "WORKER_API_URL=https://worker.example.com",
    "INVALID LINE",
  ].join("\n"));

  assert.equal(parsed.STRIPE_WEBHOOK_SECRET, "whsec_abc=def");
  assert.equal(parsed.WORKER_API_URL, "https://worker.example.com");
});

test("buildWorkerGeneratedEnv enforces required keys and defaults", () => {
  const contract = {
    worker: {
      required_local: ["CONVEX_URL", "CONVEX_HTTP_ACTIONS_URL", "WORKER_SHARED_SECRET"],
      local_defaults: {
        REDIS_URL: "redis://localhost:6379",
        PORT: "3001",
      },
    },
    vercel_pull_keys_for_worker: [
      "CONVEX_URL",
      "CONVEX_HTTP_ACTIONS_URL",
      "WORKER_SHARED_SECRET",
      "WORKER_API_URL",
    ],
  };

  const { env, sourceByKey, missingRequired } = buildWorkerGeneratedEnv(contract, {
    CONVEX_URL: "https://example.convex.cloud",
    WORKER_SHARED_SECRET: "secret",
  });

  assert.deepEqual(missingRequired, []);
  assert.equal(env.CONVEX_URL, "https://example.convex.cloud");
  assert.equal(env.CONVEX_HTTP_ACTIONS_URL, "https://example.convex.site");
  assert.equal(env.WORKER_SHARED_SECRET, "secret");
  assert.equal(env.REDIS_URL, "redis://localhost:6379");
  assert.equal(sourceByKey.REDIS_URL, "default");
  assert.equal(sourceByKey.CONVEX_HTTP_ACTIONS_URL, "derived");
});

test("deriveConvexSiteUrl normalizes Convex domains", () => {
  assert.equal(
    deriveConvexSiteUrl("https://example.convex.cloud"),
    "https://example.convex.site",
  );
  assert.equal(
    deriveConvexSiteUrl("https://example.convex.site/api/foo?bar=baz"),
    "https://example.convex.site",
  );
});

test("parseGhNameTable extracts uppercase names only", () => {
  const names = parseGhNameTable([
    "GITHUB_API_TOKEN  2026-02-01T10:00:00Z",
    "not-a-key value",
    "STRIPE_SECRET_KEY 2026-02-01T10:00:00Z",
  ].join("\n"));

  assert.equal(names.has("GITHUB_API_TOKEN"), true);
  assert.equal(names.has("STRIPE_SECRET_KEY"), true);
  assert.equal(names.has("not-a-key"), false);
});
