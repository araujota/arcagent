# Release Readiness Implementation Guide

This document defines the implementation and operations standard for shipping arcagent to production with secure environment management, consistent deployments, and scalable worker operations.

## 1. Threat Model And Trust Boundaries

### Assets
- Payment and escrow credentials (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`)
- Source-control credentials (`GITHUB_API_TOKEN`, `GITHUB_BOT_TOKEN`)
- Service-to-service auth (`WORKER_SHARED_SECRET`)
- Identity credentials (`CLERK_SECRET_KEY`, JWT issuer config)
- Convex deployment routing (`CONVEX_URL`, `WORKER_API_URL`)

### Trust boundaries
- Operator workstation: trusted for CLI execution, not a long-term secret store.
- Vercel env store: source of truth for app/worker routing + frontend credentials.
- Convex env store: source of truth for backend runtime credentials.
- GitHub Actions secrets: may contain deploy-time credentials but are not readable in plaintext via CLI.
- Worker runtime hosts: trusted compute with strict host hardening and KVM isolation.

### Primary risks
- Secret leakage via logs or committed files.
- Prod/dev drift causing inconsistent behavior.
- Wrong-environment routing values copied blindly.
- Under-hardened worker deployment under production load.

## 2. Secret Ownership And Source-Of-Truth Matrix

| Key class | Primary owner | Secondary owner | Pull path | Write path |
|---|---|---|---|---|
| Frontend public + auth bridge vars | Vercel | Local `.env.local` | `vercel env pull` | Vercel UI/CLI |
| Worker routing/shared vars | Vercel + Convex | local `worker/.env.generated` overlay | `vercel env pull` + `convex env list` | Vercel + Convex CLI |
| Backend integration secrets (GitHub/Stripe) | Convex env | Optional Vercel copy | `convex env get --prod` (when present) | `convex env set` |
| GitHub Actions secrets | GitHub | none | names-only discovery via `gh` | GitHub UI/CLI set |

Policy:
- Never commit secret-bearing generated files.
- Never print secret values in script logs.
- Use secure prompt fallback when CLI cannot expose plaintext values.

## 3. Environment Sync Pipeline

### Contract files and scripts
- `scripts/env/env_contract.json`: env source-of-truth contract.
- `scripts/env/sync_worker_from_vercel.mjs`: pulls Vercel env and writes `worker/.env.generated`.
- `scripts/env/sync_convex_prod_to_dev.mjs`: copies all Convex prod env vars to dev.
- `scripts/env/bootstrap_missing_secrets.mjs`: resolves GitHub/Stripe secrets via CLI-first + secure prompt fallback.
- `scripts/env/lib.mjs`: shared parser/sanitizer/CLI helpers.

### Standard commands
- `npm run env:sync:worker`
- `npm run env:sync:convex-parity`
- `npm run env:bootstrap:secrets`
- `npm run deploy:worker:local`

### Sanitization and storage controls
- Strip wrapping quotes from pulled values.
- Strip leading/trailing literal `\n` and real newline artifacts.
- Keep only allowlisted keys for `worker/.env.generated`.
- Write `worker/.env.generated` with mode `0600`.

## 4. Convex Prod -> Dev Parity Procedure And Rollback

### Procedure
1. Run `npm run env:sync:convex-parity`.
2. Script reads `npx convex env list --prod`.
3. Script upserts each key to dev with `npx convex env set KEY` via stdin.
4. Script prints key names only.

### Safety gate
- `sync_convex_prod_to_dev` requires `--yes` to run.
- Script emits a routing warning when `CONVEX_URL` or `WORKER_API_URL` are included.

### Rollback
1. Before parity sync, save snapshot:
   - `npx convex env list > /secure/path/convex-dev-env.snapshot`
2. To restore:
   - replay each key with `npx convex env set KEY` using snapshot values.
3. Verify with:
   - `npx convex env list`

## 5. CI/CD Hard Gates Required For Release

Minimum blocking checks for release candidates:
- Typecheck: all packages strict; no tolerated failures (`|| true` forbidden).
- Lint: zero errors.
- Build: production Next.js build with production-like env stubs.
- Tests: root/worker/mcp suites pass.
- Dependency policy: fail on critical/high vulnerabilities in prod dependencies.

Recommended release workflow stages:
1. Install + cache.
2. Lint.
3. Typecheck.
4. Unit/integration tests.
5. Production build.
6. Security audit.
7. Artifact publish/deploy.

## 6. Security Baselines

### Redaction policy
- Scripts must never log env values.
- CI logs must print key names only.
- Avoid command lines that include plaintext secrets.

### Credential scope policy
- `GITHUB_API_TOKEN`: least scope needed for repository read/index operations.
- `GITHUB_BOT_TOKEN`: repo write only for branch/workflow automation use-cases.
- Stripe keys restricted to required account and webhook endpoints.

### Rotation runbook
- Rotate `WORKER_SHARED_SECRET` atomically in Convex + worker runtime.
- Rotate Stripe/GitHub tokens through provider dashboards.
- Re-run `env:bootstrap:secrets` and `env:sync:convex-parity` after rotation.

### Incident response baseline
- Revoke suspected compromised keys immediately.
- Re-issue secrets through secure channels only.
- Replay parity sync after containment.

## 7. Scalability Baselines

### Worker throughput controls
- Tune `WORKER_CONCURRENCY` per host resources.
- Use shared Redis for multi-host scale-out.
- Keep rate limiting at worker and gateway boundaries.

### Horizontal scaling guidance
- Multi-host: shared Redis (ElastiCache or equivalent).
- Single-host: local Redis acceptable for small workloads.
- Prefer incremental worker count changes with queue depth monitoring.

### Capacity signals to monitor
- Queue depth and age.
- Verification latency percentile.
- Worker restart frequency.
- Redis command latency.

## 8. Observability And SLOs

### Required health checks
- Worker health endpoint: `/api/health`.
- Convex logs: verification dispatch and callback outcomes.
- MCP logs for auth/rate-limit errors.

### Suggested SLOs
- Verification dispatch success: >= 99.9%.
- P95 verification completion latency: target by language tier.
- Worker availability: >= 99.9%.

### Alerting thresholds
- Queue depth sustained above baseline window.
- Callback failure spike (`401/403/5xx`).
- Health endpoint degraded for > 5 minutes.

## 9. Go/No-Go Checklist

- [ ] `npm run env:test` passes.
- [ ] `npm run env:sync:worker` generated `worker/.env.generated` with required keys.
- [ ] `npm run env:sync:convex-parity` completed and dev/prod key sets match.
- [ ] `npm run env:bootstrap:secrets` resolved all GitHub/Stripe keys.
- [ ] Root/worker/mcp tests pass.
- [ ] Lint/typecheck/build gates pass in CI.
- [ ] Vulnerability policy threshold met.
- [ ] Rollback snapshot captured for Convex dev env.

## 10. Implementation Notes

- `worker/.env.generated` is intentionally ephemeral and gitignored.
- Local deploy uses env overlay precedence: `.env` base + `.env.generated` overlay.
- Worker token lookup now uses `GITHUB_API_TOKEN` first and `GITHUB_TOKEN` as deprecated fallback.
