# Cloudflare Gateway + External Execution Runtime

Use Cloudflare Workers as a gateway layer, and run the execution runtime on infrastructure you control.

This avoids Cloudflare Containers beta for production-critical execution paths.

## Architecture

- Cloudflare Worker (`worker/cloudflare/src/index.ts`) handles public ingress on `workers.dev`.
- Worker validates `Authorization: Bearer <WORKER_SHARED_SECRET>`.
- Worker proxies requests to `EXECUTION_API_BASE_URL`.
- Execution runtime remains your existing Node worker (`worker/Dockerfile` / `worker/docker-compose.yml` or AWS Firecracker deployment).

## Why This Path

- No dependency on Cloudflare Containers beta APIs.
- Keeps Firecracker/KVM execution available (Cloudflare Worker runtime cannot provide KVM).
- Preserves existing execution code and operational tooling.

## Required Cloudflare Secrets

From repository root:

```bash
CLOUDFLARE_API_TOKEN="<token>" npx wrangler secret put EXECUTION_API_BASE_URL --config worker/wrangler.cloudflare.jsonc
CLOUDFLARE_API_TOKEN="<token>" npx wrangler secret put WORKER_SHARED_SECRET --config worker/wrangler.cloudflare.jsonc
```

Optional:

```bash
CLOUDFLARE_API_TOKEN="<token>" npx wrangler secret put FORWARD_AUTH_HEADER --config worker/wrangler.cloudflare.jsonc
```

## Deploy Gateway

```bash
CLOUDFLARE_API_TOKEN="<token>" npx wrangler deploy --config worker/wrangler.cloudflare.jsonc
```

## Convex Prod Settings

Set Convex to call the Cloudflare gateway:

```bash
npx convex env set --prod WORKER_API_URL "https://arcagent-worker-gateway.<your-workers-subdomain>.workers.dev"
npx convex env set --prod WORKER_SHARED_SECRET "<same-secret-as-worker>"
```

## Execution Runtime Deployment

For local/VM deployment:

```bash
cd worker
docker compose up -d
```

For production Firecracker, use the AWS Terraform path under `infra/aws`.

## Verification

Health:

```bash
curl https://arcagent-worker-gateway.<your-workers-subdomain>.workers.dev/api/health
```

Auth-protected endpoint check:

```bash
curl -H "Authorization: Bearer <WORKER_SHARED_SECRET>" \
  https://arcagent-worker-gateway.<your-workers-subdomain>.workers.dev/api/status/<job-id>
```

## Active Env Variables After Migration

Cloudflare Worker (gateway):

- Required: `EXECUTION_API_BASE_URL`, `WORKER_SHARED_SECRET`
- Optional: `FORWARD_AUTH_HEADER`

Execution runtime (`worker/.env`):

- Required: `WORKER_SHARED_SECRET`, `CONVEX_URL`
- Required for queue/session persistence: `REDIS_URL`
- Firecracker deployments additionally require `FC_*` / KVM host prerequisites.
