#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  deriveConvexSiteUrl,
  pullConvexEnv,
  pullVercelEnv,
} from "../env/lib.mjs";

const BACKEND_PRIMARY_KEYS = [
  "CLERK_WEBHOOK_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "STRIPE_WEBHOOK_SECRET",
  "WORKER_SHARED_SECRET",
  "WORKER_API_URL",
  "CLERK_JWT_ISSUER_DOMAIN",
];

const ROUTING_PRIMARY_KEYS = [
  "CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_SITE_URL",
  "CLERK_SECRET_KEY",
  "WORKER_API_URL",
  "WORKER_SHARED_SECRET",
];

function parseEnvironmentArg(argv) {
  const index = argv.indexOf("--environment");
  return index >= 0 && argv[index + 1] ? argv[index + 1] : "production";
}

function pickValue({ key, primaryEnv, primarySource, secondaryEnv, secondarySource }) {
  const primary = primaryEnv[key];
  if (primary) {
    return { value: primary, source: primarySource };
  }

  const secondary = secondaryEnv[key];
  if (secondary) {
    return { value: secondary, source: secondarySource };
  }

  return { value: undefined, source: undefined };
}

function assembleLiveWebhookEnv({ convexEnv, vercelEnv }) {
  const env = {};
  const sourceByKey = {};

  for (const key of BACKEND_PRIMARY_KEYS) {
    const { value, source } = pickValue({
      key,
      primaryEnv: convexEnv,
      primarySource: "convex",
      secondaryEnv: vercelEnv,
      secondarySource: "vercel",
    });
    if (value) {
      env[key] = value;
      sourceByKey[key] = source;
    }
  }

  for (const key of ROUTING_PRIMARY_KEYS) {
    const { value, source } = pickValue({
      key,
      primaryEnv: vercelEnv,
      primarySource: "vercel",
      secondaryEnv: convexEnv,
      secondarySource: "convex",
    });
    if (value && !env[key]) {
      env[key] = value;
      sourceByKey[key] = source;
    }
  }

  const httpActionsUrl = convexEnv.CONVEX_HTTP_ACTIONS_URL || vercelEnv.CONVEX_HTTP_ACTIONS_URL;
  const baseUrl =
    env.NEXT_PUBLIC_CONVEX_SITE_URL ||
    httpActionsUrl ||
    deriveConvexSiteUrl(env.CONVEX_URL || env.NEXT_PUBLIC_CONVEX_URL);

  if (baseUrl) {
    env.E2E_WEBHOOK_BASE_URL = baseUrl;
    sourceByKey.E2E_WEBHOOK_BASE_URL = env.NEXT_PUBLIC_CONVEX_SITE_URL
      ? "vercel"
      : httpActionsUrl
      ? (convexEnv.CONVEX_HTTP_ACTIONS_URL ? "convex" : "vercel")
      : "derived";
  }

  return { env, sourceByKey };
}

function main() {
  const environment = parseEnvironmentArg(process.argv.slice(2));
  const convexEnv = pullConvexEnv({ prod: true });
  const vercelEnv = pullVercelEnv(environment);
  const { env, sourceByKey } = assembleLiveWebhookEnv({ convexEnv, vercelEnv });

  const required = [
    "CLERK_WEBHOOK_SECRET",
    "GITHUB_WEBHOOK_SECRET",
    "STRIPE_WEBHOOK_SECRET",
    "WORKER_SHARED_SECRET",
    "WORKER_API_URL",
    "CLERK_JWT_ISSUER_DOMAIN",
    "CONVEX_URL",
    "CLERK_SECRET_KEY",
    "E2E_WEBHOOK_BASE_URL",
  ];
  const missing = required.filter((key) => !env[key]);

  console.log(`[webhooks-live] Vercel environment: ${environment}`);
  for (const key of required) {
    if (env[key]) {
      console.log(`[webhooks-live] ${key}: set (${sourceByKey[key] ?? "unknown"})`);
    } else {
      console.log(`[webhooks-live] ${key}: missing`);
    }
  }

  if (missing.length > 0) {
    console.error(
      `[webhooks-live] Missing required live env keys: ${missing.join(", ")}`,
    );
    process.exit(1);
  }

  const result = spawnSync(
    process.execPath,
    ["--test", "scripts/e2e/webhooks.e2e.test.mjs"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        ...env,
      },
    },
  );

  process.exit(result.status ?? 1);
}

main();
