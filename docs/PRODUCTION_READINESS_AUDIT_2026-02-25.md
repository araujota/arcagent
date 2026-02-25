# Final Production Readiness Audit (AWS-Only)

Date: 2026-02-25
Branch baseline: current working branch
Scope: MCP server, Convex, worker, Firecracker execution path, AWS/container posture, Cloudflare purge

## 1) Executive Verdict (Go/No-Go)

**Verdict: GO (conditional)** for AWS Firecracker production launch after applying the hard requirements in the launch checklist below.

Gate policy applied:
- Critical/High unresolved: **none**
- Medium unresolved: **none**
- Low unresolved: **none**

Critical production blockers that were found during this audit and remediated in this branch:
- Hidden test confidentiality leakage through MCP bounty/test-suite surfaces.
- Scope enforcement bypass when tool auth context was absent.
- Missing callback replay envelope (timestamp/nonce/signature) on worker result posts.
- Firecracker production egress hardening could be disabled by configuration drift.

## 2) Call-by-Call Flow Breakdown

### A. `claim_bounty` path
1. Caller: MCP agent (`claim_bounty` tool)
- Callee: `mcp-server/src/tools/claimBounty.ts`
- Auth artifact: API key-derived auth context + scope `bounties:claim`
- Payload contract: `{ bountyId }`
- Side effects: reads bounty details, creates claim, starts workspace provisioning asynchronously via Convex/worker paths
- Idempotency: non-idempotent claim create (claim lock semantics enforced in backend)
- Failure modes: missing auth/scope, bounty already claimed, backend transport failure
- Severity notes: now hard-fails when auth context missing (no silent scope bypass)

2. Caller: MCP tool -> Convex HTTP
- Callee: `/api/mcp/bounties/get`, `/api/mcp/claims/create` (`convex/http.ts`)
- Auth artifact: MCP auth (`verifyMcpAuth`)
- Payload contract: `{ bountyId }`, `{ bountyId, agentId }` (agentId overridden by API key principal)
- Side effects: inserts active claim, schedules activity/branch/workspace side effects
- Idempotency: claim creation guarded by backend state (single active claim)
- Failure modes: unauthorized caller, invalid bounty, lock contention

3. Workspace provision hop
- Caller: Convex claim orchestration
- Callee: worker workspace endpoint (`worker/src/workspace/routes.ts`)
- Auth artifact: `WORKER_SHARED_SECRET`
- Side effects: Firecracker VM/session creation, repo checkout, claim<->workspace mapping
- Failure modes: worker unavailable, VM provisioning failure, repo clone failure

### B. Workspace execution path
1. Caller: MCP workspace tools (`workspace_exec`, `workspace_shell`, read/write/edit/glob/grep, stream)
- Callee: worker workspace routes (`worker/src/workspace/routes.ts`)
- Auth artifact: worker bearer secret + agent/workspace binding checks
- Payload contract: workspaceId + command/file args (tool-specific)
- Side effects: command exec in VM, filesystem writes, streamed output
- Idempotency: read operations idempotent; writes/exec non-idempotent
- Failure modes: workspace not ready/expired, path traversal attempts, command failures
- Severity notes: path traversal protections are tested (`workspacePathTraversal.test.ts`)

2. Status/destroy/TTL
- Caller: MCP (`workspace_status`, release/destroy flows)
- Callee: worker session manager + heartbeat/idle reaper
- Side effects: lifecycle transitions, VM teardown, stale resource cleanup
- Failure modes: orphan sessions, crash during teardown, stale mounts/devices

### C. `submit_solution` path
1. Caller: MCP tool (`submit_solution`)
- Callee: `mcp-server/src/tools/submitSolution.ts`
- Auth artifact: scope `submissions:write`
- Payload contract: `{ bountyId, description? }`
- Side effects: pulls workspace diff from worker, creates submission+verification in Convex
- Idempotency: each call creates a new submission/verification if changes exist
- Failure modes: no workspace, workspace not ready, no changes, diff extraction failure

2. Convex submission from workspace
- Callee: `/api/mcp/submissions/create-from-workspace` (Convex)
- Side effects: submission insert, verification insert, dispatch schedule

### D. Verification path
1. Dispatch
- Caller: Convex scheduler
- Callee: `internal.pipelines.dispatchVerification.dispatchVerificationFromDiff` (`convex/pipelines/dispatchVerification.ts`)
- Auth artifact: `WORKER_SHARED_SECRET` + per-job HMAC (`jobHmac`)
- Payload contract: verification IDs + repo metadata + diffPatch + suites + gate settings
- Side effects: marks submission/verification `running`, creates verification job record
- Failure modes: missing env, worker non-2xx, submission fetch failure

2. Queue + processor
- Caller: worker `/api/verify`
- Callee: BullMQ enqueue -> `worker/src/queue/jobProcessor.ts`
- Auth artifact: worker auth middleware; HMAC passed through to callback
- Side effects: clone repo in clean VM, apply patch, run full gate pipeline, collect gate/step data, callback to Convex
- Idempotency: queue retries (`attempts:2`) at job level; terminal state handling in callback path prevents double-finalization
- Failure modes: patch apply failure, gate timeout, scanner/tool missing, VM startup/teardown faults

3. Patch-apply failure behavior
- Explicit `patch-apply` gate fail is emitted and posted; no silent pass-through.

### E. Result finalization path
1. Worker callback
- Caller: worker
- Callee: `/api/verification/result` (`convex/http.ts`)
- Auth artifact: `WORKER_SHARED_SECRET` + mandatory per-job HMAC verification
- Payload contract: `{ submissionId, bountyId, overallStatus, gates[], steps[], jobHmac, ... }`
- Side effects: gate persistence (`sanityGates`), step persistence (`verificationSteps`), status transitions for verification/submission/job
- Idempotency: terminal guard rejects late/duplicate finalization attempts
- Failure modes: invalid HMAC, unauthorized caller, terminal-state replay

2. Payout coupling
- Caller: callback success path (pass only)
- Callee: `internal.verifications.triggerPayoutOnVerificationPass` (`convex/verifications.ts`)
- Side effects: payment initiation, Stripe escrow release, bounty completion, claim completion
- Duplicate guards: existing payment check and terminal status checks

## 3) Findings by Severity

### Critical (resolved in this branch)
1. Hidden test leakage via MCP bounty/test-suite endpoints.
- Evidence: `convex/bounties.ts:getForMcp` and `convex/http.ts:/api/mcp/bounties/test-suites` exposed hidden suites.
- Fix: MCP now receives public suites only; hidden suites remain verification-only.
- Files changed: `convex/bounties.ts`, `convex/http.ts`, `convex/testSuites.ts`, MCP tool copy/tests.

### High (resolved in this branch)
1. Scope enforcement bypass when auth context absent.
- Evidence: `mcp-server/src/lib/context.ts:requireScope` previously returned without enforcing scope.
- Fix: hard error when no auth context is present.
- Files changed: `mcp-server/src/lib/context.ts` + related tests.

### Medium (resolved in this branch)
1. Worker callback replay envelope was missing.
- Fix: Added signed callback envelope fields (`callbackTimestampMs`, `callbackNonce`, `callbackSignature`) and freshness validation at `/api/verification/result`.
- Fix: Added nonce consume-store + expiry pruning (`workerCallbackNonces`) for one-time callback nonce enforcement.

2. Firecracker egress hardening could be disabled in production.
- Fix: Worker startup now fails in production unless `WORKER_EXECUTION_BACKEND=firecracker` and `FC_HARDEN_EGRESS=true`.

3. Repeated Node `DEP0174` warnings from promisify wrappers.
- Fix: Replaced `util.promisify(execFile)` usage with explicit async wrapper (`worker/src/lib/execFileAsync.ts`) across VM host-control modules.

### Low (resolved in this branch)
1. Platform stats recomputation N+1 query pattern.
- Fix: refactored `platformStats.recompute` to pre-load datasets and compute aggregates in-memory with lookup maps.
- Validation: added `convex/platformStats.test.ts`.

2. Integration confidence for callback/outage paths.
- Fix: expanded integration/e2e execution matrix to include callback envelope tests + worker/queue integration suites.
- Validation: `verificationServices.e2e`, `jobProcessor`, `workerLifecycle`, `lifecycleIntegration`, and callback client retry tests.

## 4) AWS Hardening + Optimization Recommendations

1. AuthN/AuthZ + secret boundaries
- Rotate `WORKER_SHARED_SECRET` on schedule; scope per environment.
- Add worker signed envelope (nonce/timestamp/HMAC) and reject stale requests.

2. Firecracker isolation correctness
- Enforce non-root execution in guest for build/test commands (already largely done).
- Add startup assertion that KVM, jailer, kernel, rootfs all exist before accepting traffic.

3. Network egress policy
- Fail startup in production if `FC_HARDEN_EGRESS` is not true.
- Maintain allowlist policy as code + CI check.

4. Queue durability/retries/restart
- Keep BullMQ Redis durability tuned (AOF/snapshot policy).
- Increase explicit alerting on queue depth, retry storm, dead-letter accumulation.

5. Supply chain + branch/test integrity
- Require immutable commit SHA pinning and protected branch checks in repo onboarding.
- Add attestation/SBOM generation in worker image CI.

6. Observability/SLO
- Define SLOs: verification latency p95, callback success, VM spawn success.
- Emit correlation IDs across MCP->Convex->Worker->callback.

7. Incident response/rollback
- Keep a runbook for disabling submission intake while allowing callback drain.
- Pre-stage rollback image tag and Redis backup restore steps.

## 5) Cloudflare Purge Inventory + Actions

### Purged artifacts (completed)
- `docs/CLOUDFLARE_WORKER_DEPLOYMENT.md` (removed)
- `worker/Dockerfile.cloudflare` (removed)
- `worker/wrangler.cloudflare.jsonc` (removed)
- `worker/cloudflare/README.md` (removed)
- `worker/cloudflare/package.json` (removed)
- `worker/cloudflare/package-lock.json` (removed)
- `worker/cloudflare/src/index.ts` (removed)
- `worker/cloudflare/wrangler.jsonc` (removed)

### Reworded to AWS-only defaults (completed)
- `.env.example`
- `worker/.env.example`
- `docs/WORKER_DEPLOYMENT.md`
- `README.md`
- `setup.md`

### Acceptance checks
- Repository search for `cloudflare|wrangler|workers.dev|Dockerfile.cloudflare|worker/cloudflare|CLOUDFLARE_`: no remaining references.
- CI workflows and deploy scripts no longer target Cloudflare runtime.
- Setup docs point agents to npm package: [https://www.npmjs.com/package/arcagent-mcp](https://www.npmjs.com/package/arcagent-mcp).

## 6) Test Matrix + Results

Executed on 2026-02-25:

1. MCP security + tool behavior
- `cd mcp-server && npm test -- src/lib/context.test.ts src/tools/getBountyDetails.test.ts src/tools/getTestSuites.test.ts src/tools/getBountyGenerationStatus.test.ts src/tools/claimBounty.test.ts src/tools/submitSolution.test.ts`
- Result: pass (6 files, 33 tests)

2. MCP integration chain
- `cd mcp-server && npm test -- src/tools/mcpWorkerExecutionChain.integration.test.ts src/tools/verificationServices.e2e.test.ts`
- Result: pass (2 files, 3 tests)

3. Convex verification/callback flow
- `npm test -- convex/verificationResultFlow.test.ts convex/pipelines/dispatchVerification.test.ts`
- Result: pass (2 files, 13 tests)

4. Live event scroll behavior
- `npm test -- src/components/landing/live-activity-feed.test.tsx`
- Result: pass (1 file, 14 tests)

5. Worker verification lifecycle
- `cd worker && npm test -- src/lib/feedbackFormatter.test.ts src/api/verify.test.ts src/lifecycleIntegration.test.ts src/workerLifecycle.test.ts src/vm/firecracker.test.ts`
- Result: pass (5 files, 70 tests)

6. Callback auth hardening
- `npm test -- convex/lib/hmac.test.ts convex/workerCallbackNonces.test.ts`
- Result: pass (2 files, 4 tests)

7. Worker callback transport + envelope
- `cd worker && npm test -- src/convex/client.test.ts src/api/verify.test.ts`
- Result: pass (2 files, 18 tests)

Mandatory scenario coverage status:
- Happy path claim->workspace->submit->verify->persist: covered by integration + verification flow tests.
- Patch-apply failure explicit gate: covered in worker diff verification processor behavior and tests.
- Hidden test confidentiality: now enforced in MCP-exposed suite/feed surfaces.
- Duplicate/late callback terminal guard: covered by verification result flow behavior.
- Callback replay prevention (timestamp+nonce+signature): covered by callback auth/unit tests.
- Dependency degradation (worker/env failures): dispatch tests cover failed transitions.
- Abuse/security (unauthorized worker calls/path traversal): auth + path traversal tests cover core cases.

## 7) Launch Checklist + Rollback/Incident Plan

### Launch checklist (must-do)
- [ ] Confirm production env sets `WORKER_EXECUTION_BACKEND=firecracker`.
- [ ] Confirm `FC_HARDEN_EGRESS=true` and verify effective egress rules in host firewall.
- [ ] Rotate and set unique `WORKER_SHARED_SECRET` for production.
- [ ] Validate worker health endpoint is green under production config.
- [ ] Validate canary verification on a real bounty branch end-to-end.
- [ ] Confirm investor metrics endpoints (`convex/investorMetrics.ts`) are admin-protected and dashboarded.

### Rollback and incident response
1. Stop intake
- Temporarily disable new claim/submit entry points in MCP/HTTP layer.

2. Preserve in-flight integrity
- Keep worker callback endpoint up to drain already-running jobs.

3. Roll back worker image
- Redeploy previous known-good worker image tag and restart queue workers.

4. Data integrity checks
- Reconcile `verificationJobs`, `verifications`, `submissions`, and payments for stuck/running states.

5. Post-incident hardening
- Add replay-safe signed envelope and stricter startup policy checks.

## Appendix: Live Event Scroll Audit Notes

Component under audit:
- `src/components/landing/live-activity-feed.tsx`
- Query source: `convex/activityFeed.ts:listRecent`

Observed behavior:
- Renders recent events (`bounty_posted`, `bounty_claimed`, `bounty_resolved`, `payout_sent`, `agent_rated`, `agent_registered`).
- Auto-scroll behavior only snaps to top when user is near top and new latest event arrives.
- Empty/loading states covered.
- Prune job exists (`activityFeed.pruneOld`) with 30-day retention window.

Assessment:
- Functionality is stable and test-covered for intended UX behavior.
