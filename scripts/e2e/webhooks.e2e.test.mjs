import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Webhook as SvixWebhook } from "svix";

const baseUrl =
  process.env.E2E_WEBHOOK_BASE_URL ??
  process.env.CONVEX_SITE_URL;

const required = {
  CLERK_WEBHOOK_SECRET: process.env.CLERK_WEBHOOK_SECRET,
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
};

const missing = Object.entries(required)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length > 0) {
  throw new Error(
    `Missing required env vars for webhook E2E tests: ${missing.join(", ")}`
  );
}

if (!baseUrl) {
  throw new Error(
    "Missing E2E_WEBHOOK_BASE_URL or CONVEX_SITE_URL for webhook E2E tests"
  );
}

function githubSignature(payload, secret) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return `sha256=${digest}`;
}

function stripeSignature(payload, secret, timestamp) {
  const signedPayload = `${timestamp}.${payload}`;
  const digest = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

async function post(path, body, headers) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

test("github webhook accepts valid ping signature", async () => {
  const payload = JSON.stringify({
    zen: "Keep it logically awesome.",
    hook_id: 123456,
    repository: { full_name: "araujota/arcagent" },
  });
  const res = await post("/github-webhook", payload, {
    "x-github-event": "ping",
    "x-hub-signature-256": githubSignature(
      payload,
      required.GITHUB_WEBHOOK_SECRET
    ),
  });

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "pong");
});

test("github webhook rejects invalid signature", async () => {
  const payload = JSON.stringify({
    zen: "Signature should fail",
    hook_id: 654321,
    repository: { full_name: "araujota/arcagent" },
  });
  const res = await post("/github-webhook", payload, {
    "x-github-event": "ping",
    "x-hub-signature-256": githubSignature(
      payload,
      `${required.GITHUB_WEBHOOK_SECRET}-invalid`
    ),
  });

  assert.equal(res.status, 401);
  assert.equal(await res.text(), "Invalid signature");
});

test("clerk webhook accepts valid Svix signature", async () => {
  const payload = JSON.stringify({
    type: "user.deleted",
    data: {
      id: `user_e2e_${Date.now()}`,
    },
  });
  const webhook = new SvixWebhook(required.CLERK_WEBHOOK_SECRET);
  const msgId = `msg_${Date.now()}`;
  const tsDate = new Date();

  const res = await post("/clerk-webhook", payload, {
    "svix-id": msgId,
    "svix-timestamp": Math.floor(tsDate.getTime() / 1000).toString(),
    "svix-signature": webhook.sign(msgId, tsDate, payload),
  });

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "OK");
});

test("clerk webhook rejects invalid Svix signature", async () => {
  const payload = JSON.stringify({
    type: "user.deleted",
    data: {
      id: `user_e2e_bad_${Date.now()}`,
    },
  });
  const webhook = new SvixWebhook(required.CLERK_WEBHOOK_SECRET);
  const msgId = `msg_${Date.now()}`;
  const tsDate = new Date();
  const validSignature = webhook.sign(msgId, tsDate, payload);
  const invalidSignature = `${validSignature}x`;

  const res = await post("/clerk-webhook", payload, {
    "svix-id": msgId,
    "svix-timestamp": Math.floor(tsDate.getTime() / 1000).toString(),
    "svix-signature": invalidSignature,
  });

  assert.equal(res.status, 400);
  assert.equal(await res.text(), "Invalid signature");
});

test("stripe webhook accepts valid signature", async () => {
  const payload = JSON.stringify({
    id: `evt_e2e_${Date.now()}`,
    object: "event",
    type: "customer.created",
    data: {
      object: {
        id: `cus_e2e_${Date.now()}`,
        object: "customer",
      },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await post("/stripe-webhook", payload, {
    "stripe-signature": stripeSignature(
      payload,
      required.STRIPE_WEBHOOK_SECRET,
      timestamp
    ),
  });

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "OK");
});

test("stripe webhook rejects invalid signature", async () => {
  const payload = JSON.stringify({
    id: `evt_e2e_bad_${Date.now()}`,
    object: "event",
    type: "customer.created",
    data: {
      object: {
        id: `cus_e2e_bad_${Date.now()}`,
        object: "customer",
      },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await post("/stripe-webhook", payload, {
    "stripe-signature": stripeSignature(
      payload,
      `${required.STRIPE_WEBHOOK_SECRET}-invalid`,
      timestamp
    ),
  });

  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /Webhook Error:/);
});
