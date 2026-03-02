import test from "node:test";
import assert from "node:assert/strict";
import { createSign } from "node:crypto";

const DEFAULT_TIMEOUT_MS = Number(process.env.ENV_SMOKE_TIMEOUT_MS ?? "15000");
const USER_AGENT = "arcagent-env-smoke/1.0";

function readEnv(name) {
  const value = process.env[name];
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireEnvOrSkip(t, keys) {
  const values = {};
  const missing = [];

  for (const key of keys) {
    const value = readEnv(key);
    if (!value) {
      missing.push(key);
    } else {
      values[key] = value;
    }
  }

  if (missing.length > 0) {
    t.skip(`Missing env: ${missing.join(", ")}`);
    return null;
  }

  return values;
}

function requireSingleEnvOrSkip(t, key) {
  const value = readEnv(key);
  if (!value) {
    t.skip(`Missing env: ${key}`);
    return null;
  }
  return value;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function toBase64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function normalizePem(value) {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

function assertSizedSecret(value, keyName, minLength = 32) {
  assert.ok(value.length >= minLength, `${keyName} must be at least ${minLength} chars`);
}

async function assertJsonResponse(res, context) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    assert.fail(`${context}: expected JSON response, got status=${res.status}`);
  }
}

test("APP_BASE_URL parses as absolute URL", (t) => {
  const value = requireSingleEnvOrSkip(t, "APP_BASE_URL");
  if (!value) return;
  const url = new URL(value);
  assert.ok(url.protocol === "https:" || url.protocol === "http:");
  assert.ok(Boolean(url.host));
});

test("OAUTH_STATE_SIGNING_KEY supports HMAC signing", async (t) => {
  const values = requireEnvOrSkip(t, ["OAUTH_STATE_SIGNING_KEY"]);
  if (!values) return;

  assertSizedSecret(values.OAUTH_STATE_SIGNING_KEY, "OAUTH_STATE_SIGNING_KEY");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(values.OAUTH_STATE_SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const payload = new TextEncoder().encode("arcagent-oauth-state-smoke");
  const sig = await crypto.subtle.sign("HMAC", key, payload);
  assert.ok(new Uint8Array(sig).length > 0, "HMAC signature should be non-empty");
});

test("PROVIDER_TOKEN_ENCRYPTION_KEY supports AES-GCM roundtrip", async (t) => {
  const values = requireEnvOrSkip(t, ["PROVIDER_TOKEN_ENCRYPTION_KEY"]);
  if (!values) return;

  assertSizedSecret(values.PROVIDER_TOKEN_ENCRYPTION_KEY, "PROVIDER_TOKEN_ENCRYPTION_KEY");

  const secret = new TextEncoder().encode(values.PROVIDER_TOKEN_ENCRYPTION_KEY);
  const digest = await crypto.subtle.digest("SHA-256", secret);
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode("arcagent-provider-token-smoke");
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
  assert.equal(new TextDecoder().decode(decrypted), "arcagent-provider-token-smoke");
});

for (const [key, minLength] of [
  ["GITHUB_WEBHOOK_SECRET", 1],
  ["GITLAB_WEBHOOK_SECRET", 1],
  ["BITBUCKET_WEBHOOK_SECRET", 1],
  ["WORKER_SHARED_SECRET", 32],
  ["MCP_SHARED_SECRET", 32],
  ["MCP_AUDIT_LOG_TOKEN", 32],
  ["WORKER_TOKEN_SIGNING_SECRET", 32],
]) {
  test(`${key} has sufficient entropy length`, (t) => {
    const value = requireSingleEnvOrSkip(t, key);
    if (!value) return;
    assertSizedSecret(value, key, minLength);
  });
}

test("STRIPE_WEBHOOK_SECRET has expected prefix", (t) => {
  const value = requireSingleEnvOrSkip(t, "STRIPE_WEBHOOK_SECRET");
  if (!value) return;
  assert.ok(value.startsWith("whsec_"), "STRIPE_WEBHOOK_SECRET should start with whsec_");
});

test("CLERK_WEBHOOK_SECRET has expected prefix", (t) => {
  const value = requireSingleEnvOrSkip(t, "CLERK_WEBHOOK_SECRET");
  if (!value) return;
  assert.ok(value.startsWith("whsec_"), "CLERK_WEBHOOK_SECRET should start with whsec_");
});

test("CLERK_JWT_ISSUER_DOMAIN serves OIDC configuration", async (t) => {
  const domain = requireSingleEnvOrSkip(t, "CLERK_JWT_ISSUER_DOMAIN");
  if (!domain) return;

  const response = await fetchWithTimeout(`${domain.replace(/\/$/, "")}/.well-known/openid-configuration`, {
    headers: { "User-Agent": USER_AGENT },
  });
  assert.equal(response.status, 200, "Expected Clerk issuer OIDC configuration endpoint to return 200");
});

test("GitHub API token authenticates", async (t) => {
  const token = requireSingleEnvOrSkip(t, "GITHUB_API_TOKEN");
  if (!token) return;

  const response = await fetchWithTimeout("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
    },
  });
  assert.equal(response.status, 200, "Expected GitHub API token to authenticate via /user");
});

test("GitHub bot token authenticates", async (t) => {
  const token = requireSingleEnvOrSkip(t, "GITHUB_BOT_TOKEN");
  if (!token) return;

  const response = await fetchWithTimeout("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
    },
  });
  assert.equal(response.status, 200, "Expected GitHub bot token to authenticate via /user");
});

test("GitHub App private key signs JWT and authenticates as app", async (t) => {
  const values = requireEnvOrSkip(t, ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]);
  if (!values) return;

  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = toBase64Url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: values.GITHUB_APP_ID,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const jwt = `${unsigned}.${signer.sign(normalizePem(values.GITHUB_APP_PRIVATE_KEY), "base64url")}`;

  const response = await fetchWithTimeout("https://api.github.com/app", {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
    },
  });
  assert.equal(response.status, 200, "Expected GitHub App JWT to authenticate via /app");
});

test("GitHub App OAuth client id/secret accepted by token endpoint", async (t) => {
  const values = requireEnvOrSkip(t, ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"]);
  if (!values) return;

  const form = new URLSearchParams({
    client_id: values.GITHUB_APP_CLIENT_ID,
    client_secret: values.GITHUB_APP_CLIENT_SECRET,
    code: "arcagent-smoke-test-invalid-code",
  });
  const response = await fetchWithTimeout("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: form.toString(),
  });

  const payload = await assertJsonResponse(response, "GitHub OAuth token exchange");
  assert.notEqual(
    payload.error,
    "incorrect_client_credentials",
    "GitHub OAuth client credentials rejected",
  );
});

test("GitLab OAuth client id/secret accepted by token endpoint", async (t) => {
  const values = requireEnvOrSkip(t, ["GITLAB_CLIENT_ID", "GITLAB_CLIENT_SECRET", "APP_BASE_URL"]);
  if (!values) return;

  const form = new URLSearchParams({
    client_id: values.GITLAB_CLIENT_ID,
    client_secret: values.GITLAB_CLIENT_SECRET,
    code: "arcagent-smoke-test-invalid-code",
    grant_type: "authorization_code",
    redirect_uri: `${values.APP_BASE_URL.replace(/\/$/, "")}/oauth/gitlab/callback`,
  });
  const response = await fetchWithTimeout("https://gitlab.com/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: form.toString(),
  });

  const payload = await assertJsonResponse(response, "GitLab OAuth token exchange");
  assert.notEqual(payload.error, "invalid_client", "GitLab OAuth client credentials rejected");
});

test("Bitbucket OAuth client id/secret accepted by token endpoint", async (t) => {
  const values = requireEnvOrSkip(t, ["BITBUCKET_CLIENT_ID", "BITBUCKET_CLIENT_SECRET", "APP_BASE_URL"]);
  if (!values) return;

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: "arcagent-smoke-test-invalid-code",
    redirect_uri: `${values.APP_BASE_URL.replace(/\/$/, "")}/oauth/bitbucket/callback`,
  });
  const auth = Buffer.from(`${values.BITBUCKET_CLIENT_ID}:${values.BITBUCKET_CLIENT_SECRET}`).toString("base64");
  const response = await fetchWithTimeout("https://bitbucket.org/site/oauth2/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: form.toString(),
  });

  const payload = await assertJsonResponse(response, "Bitbucket OAuth token exchange");
  assert.notEqual(payload.error, "invalid_client", "Bitbucket OAuth client credentials rejected");
});

test("Linear OAuth client id/secret accepted by token endpoint", async (t) => {
  const values = requireEnvOrSkip(t, ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "APP_BASE_URL"]);
  if (!values) return;

  const response = await fetchWithTimeout("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: values.LINEAR_CLIENT_ID,
      client_secret: values.LINEAR_CLIENT_SECRET,
      code: "arcagent-smoke-test-invalid-code",
      grant_type: "authorization_code",
      redirect_uri: `${values.APP_BASE_URL.replace(/\/$/, "")}/oauth/linear/callback`,
    }),
  });

  const payload = await assertJsonResponse(response, "Linear OAuth token exchange");
  assert.notEqual(payload.error, "invalid_client", "Linear OAuth client credentials rejected");
});

test("Jira OAuth client id/secret accepted by token endpoint", async (t) => {
  const values = requireEnvOrSkip(t, ["JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET", "APP_BASE_URL"]);
  if (!values) return;

  const response = await fetchWithTimeout("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: values.JIRA_CLIENT_ID,
      client_secret: values.JIRA_CLIENT_SECRET,
      code: "arcagent-smoke-test-invalid-code",
      grant_type: "authorization_code",
      redirect_uri: `${values.APP_BASE_URL.replace(/\/$/, "")}/oauth/jira/callback`,
    }),
  });

  const payload = await assertJsonResponse(response, "Jira OAuth token exchange");
  assert.notEqual(payload.error, "invalid_client", "Jira OAuth client credentials rejected");
});

test("GitLab API token authenticates", async (t) => {
  const token = requireSingleEnvOrSkip(t, "GITLAB_API_TOKEN");
  if (!token) return;

  const response = await fetchWithTimeout("https://gitlab.com/api/v4/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  assert.equal(response.status, 200, "Expected GITLAB_API_TOKEN to authenticate via /api/v4/user");
});

test("GitLab fallback API token authenticates", async (t) => {
  const token = requireSingleEnvOrSkip(t, "GITLAB_FALLBACK_API_TOKEN");
  if (!token) return;

  const response = await fetchWithTimeout("https://gitlab.com/api/v4/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  assert.equal(
    response.status,
    200,
    "Expected GITLAB_FALLBACK_API_TOKEN to authenticate via /api/v4/user",
  );
});

test("Bitbucket app password authenticates", async (t) => {
  const values = requireEnvOrSkip(t, ["BITBUCKET_USERNAME", "BITBUCKET_APP_PASSWORD"]);
  if (!values) return;

  const auth = Buffer.from(`${values.BITBUCKET_USERNAME}:${values.BITBUCKET_APP_PASSWORD}`).toString("base64");
  const response = await fetchWithTimeout("https://api.bitbucket.org/2.0/user", {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  assert.equal(response.status, 200, "Expected Bitbucket app password credentials to authenticate");
});

test("Bitbucket fallback app password authenticates", async (t) => {
  const values = requireEnvOrSkip(t, ["BITBUCKET_FALLBACK_USERNAME", "BITBUCKET_FALLBACK_APP_PASSWORD"]);
  if (!values) return;

  const auth = Buffer.from(
    `${values.BITBUCKET_FALLBACK_USERNAME}:${values.BITBUCKET_FALLBACK_APP_PASSWORD}`,
  ).toString("base64");
  const response = await fetchWithTimeout("https://api.bitbucket.org/2.0/user", {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  assert.equal(
    response.status,
    200,
    "Expected fallback Bitbucket app password credentials to authenticate",
  );
});

test("Stripe secret key authenticates", async (t) => {
  const key = requireSingleEnvOrSkip(t, "STRIPE_SECRET_KEY");
  if (!key) return;

  const response = await fetchWithTimeout("https://api.stripe.com/v1/account", {
    headers: {
      Authorization: `Bearer ${key}`,
      "User-Agent": USER_AGENT,
    },
  });
  assert.equal(response.status, 200, "Expected STRIPE_SECRET_KEY to authenticate via /v1/account");
});

test("Clerk secret key authenticates", async (t) => {
  const key = requireSingleEnvOrSkip(t, "CLERK_SECRET_KEY");
  if (!key) return;

  const response = await fetchWithTimeout("https://api.clerk.com/v1/users?limit=1", {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  assert.equal(response.status, 200, "Expected CLERK_SECRET_KEY to authenticate via /v1/users");
});

test("Resend API key authenticates", async (t) => {
  const key = requireSingleEnvOrSkip(t, "RESEND_API_KEY");
  if (!key) return;

  const response = await fetchWithTimeout("https://api.resend.com/domains", {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  assert.equal(response.status, 200, "Expected RESEND_API_KEY to authenticate via /domains");
});

test("Anthropic API key authenticates", async (t) => {
  const key = requireSingleEnvOrSkip(t, "ANTHROPIC_API_KEY");
  if (!key) return;

  const response = await fetchWithTimeout("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  assert.equal(response.status, 200, "Expected ANTHROPIC_API_KEY to authenticate via /v1/models");
});

test("OpenAI API key authenticates", async (t) => {
  const key = requireSingleEnvOrSkip(t, "OPENAI_API_KEY");
  if (!key) return;

  const response = await fetchWithTimeout("https://api.openai.com/v1/models", {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  assert.equal(response.status, 200, "Expected OPENAI_API_KEY to authenticate via /v1/models");
});

test("Voyage API key authorizes embeddings endpoint", async (t) => {
  const key = requireSingleEnvOrSkip(t, "VOYAGE_AI_API_KEY");
  if (!key) return;

  const response = await fetchWithTimeout("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      model: "voyage-3-large",
      input: ["arcagent smoke"],
    }),
  });

  assert.notEqual(response.status, 401, "Voyage API key rejected by embeddings endpoint");
  assert.notEqual(response.status, 403, "Voyage API key forbidden by embeddings endpoint");
});

test("SonarQube token authenticates", async (t) => {
  const values = requireEnvOrSkip(t, ["SONARQUBE_URL", "SONARQUBE_TOKEN"]);
  if (!values) return;

  const base = values.SONARQUBE_URL.replace(/\/$/, "");
  const auth = Buffer.from(`${values.SONARQUBE_TOKEN}:`).toString("base64");
  const response = await fetchWithTimeout(`${base}/api/system/status`, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  assert.equal(response.status, 200, "Expected SonarQube token to authenticate via /api/system/status");
});

test("Snyk token authenticates", async (t) => {
  const token = requireSingleEnvOrSkip(t, "SNYK_TOKEN");
  if (!token) return;

  const response = await fetchWithTimeout("https://api.snyk.io/v1/user/me", {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  assert.equal(response.status, 200, "Expected SNYK_TOKEN to authenticate via /v1/user/me");
});

test("AWS key env format sanity", async (t) => {
  const values = requireEnvOrSkip(t, ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
  if (!values) return;

  assert.match(
    values.AWS_ACCESS_KEY_ID,
    /^(AKIA|ASIA)[A-Z0-9]{16}$/,
    "AWS_ACCESS_KEY_ID format is unexpected",
  );
  assert.match(
    values.AWS_SECRET_ACCESS_KEY,
    /^[A-Za-z0-9/+=]{40}$/,
    "AWS_SECRET_ACCESS_KEY format is unexpected",
  );
});
