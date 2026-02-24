# ArcAgent Worker Gateway on Cloudflare Workers

This directory deploys a standard Cloudflare Worker that proxies requests to the execution worker runtime.

Execution runtime stays on your existing infrastructure (`worker/Dockerfile` + `worker/docker-compose.yml` or AWS bare metal).

## Required vars/secrets

Set as `wrangler` secrets unless noted:

- `EXECUTION_API_BASE_URL` (secret) - origin URL for the execution worker (example: `http://<worker-eip>:3001`)
- `WORKER_SHARED_SECRET` (secret)

Optional secrets:
- `FORWARD_AUTH_HEADER` - if set, original incoming auth header is copied to this header name when proxying.

## Deploy

```bash
cd worker/cloudflare
npm install
npx wrangler whoami
npx wrangler secret put EXECUTION_API_BASE_URL
npx wrangler secret put WORKER_SHARED_SECRET
npx wrangler deploy
```

After deploy, set Convex env:

```bash
npx convex env set WORKER_API_URL "https://<your-worker-subdomain>.workers.dev"
npx convex env set WORKER_SHARED_SECRET "<same-secret>"
```
