# MVP Master Guide

> **Purpose**: A conservative, scope-creep-resistant checklist of exactly what must be completed before arcagent can be released and tested with real clients and agents. Completing every item in the **Blockers** and **Required** sections certifies the application as ready for v1 launch.
>
> **Date**: 2026-02-17
> **Branch**: `claude/compare-ui-functionality-JFiKH`

---

## Table of Contents

1. [What MVP Means](#1-what-mvp-means)
2. [Blockers — Cannot Launch Without These](#2-blockers)
3. [Required — Must Have for Credible v1](#3-required)
4. [Explicitly Out of Scope for v1](#4-out-of-scope)
5. [Environment Variable Audit](#5-environment-variable-audit)
6. [Verification Checklist](#6-verification-checklist)

---

## 1. What MVP Means

The v1 MVP is the minimum product that supports this end-to-end flow:

```
Creator: sign up → create bounty → fund escrow → publish
Agent:   register API key → browse bounties → claim → work in VM → submit
System:  verify submission (8-gate pipeline) → release escrow to agent
```

Anything that does not directly block this flow is post-MVP. Web3 payments, dispute resolution, admin panels, multi-language rootfs, external monitoring — all post-MVP.

---

## 2. Blockers

These are defects or missing functionality that prevent the core flow from working end-to-end. **Each must be fixed before any real user can test the platform.**

### B1. No Web UI to Fund Bounty Escrow

**Impact**: Creators cannot publish bounties through the web interface.

`createEscrowCharge` is an `internalAction` in `convex/stripe.ts`. The MCP tool `fund_bounty_escrow` calls it, but there is no equivalent frontend action. The bounty detail page's `PublishDraftButton` is gated on `escrowStatus === "funded"`, creating a dead end.

**Fix**: Add a public Convex action (Clerk-authed) that wraps `createEscrowCharge`, callable from a "Fund Escrow" button on the bounty detail page (`src/app/(dashboard)/bounties/[id]/page.tsx`). The button should appear for creators viewing their own draft/unfunded bounties.

**Files**: `convex/stripe.ts` (new public action), `src/app/(dashboard)/bounties/[id]/page.tsx` (new button + mutation call)

---

### B2. Session Store Not Wired Into Session Manager

**Impact**: Workspace sessions exist only in worker process memory. If the worker restarts, all active workspaces are lost with no way to recover.

`sessionStore.save()` from `worker/src/workspace/sessionStore.ts` is never called from `provisionWorkspace()` in `worker/src/workspace/sessionManager.ts`. The Redis session store is fully implemented but disconnected.

**Fix**: In `sessionManager.ts`, after a workspace reaches "ready" status, call `sessionStore.save()` with the full `SessionRecord` (extracting `firecrackerPid`, `tapDevice`, `overlayPath`, `vsockSocketPath` from the VMHandle). Also call `sessionStore.updateStatus()` on status changes and `sessionStore.delete()` on destroy.

**Files**: `worker/src/workspace/sessionManager.ts`

---

### B3. Crash Recovery Not Wired Into Worker Startup

**Impact**: The crash recovery system (`worker/src/workspace/recovery.ts`) is complete code that never executes. Orphaned VMs from worker restarts are never reclaimed.

Neither `generateWorkerInstanceId()` nor `recoverOrphanedSessions()` is imported or called from `worker/src/index.ts`.

**Fix**: In `worker/src/index.ts` `main()`, after existing initialization:
1. Call `generateWorkerInstanceId()` to create a stable instance ID
2. Call `recoverOrphanedSessions(instanceId)` to scan Redis for orphaned sessions
3. Call `workspaceHeartbeat.startWorkerHeartbeat(instanceId)` to begin the 15s Redis heartbeat

**Files**: `worker/src/index.ts`

---

### B4. Heartbeat System Not Wired Into Provisioning or Shutdown

**Impact**: VM crashes are never detected. The `WorkspaceHeartbeat` class in `worker/src/workspace/heartbeat.ts` is dead code.

`startMonitoring()` is never called when a workspace is provisioned. `stopMonitoring()` is never called on destroy. `stopAll()` is never called on shutdown.

**Fix**:
- In `provisionWorkspace()`: after workspace is "ready", call `workspaceHeartbeat.startMonitoring(workspaceId, vsockSocketPath, vmId)`
- In `destroyWorkspace()`: call `workspaceHeartbeat.stopMonitoring(workspaceId)`
- In shutdown handler in `index.ts`: call `workspaceHeartbeat.stopAll()`

**Files**: `worker/src/workspace/sessionManager.ts`, `worker/src/index.ts`

---

### B5. `__firecrackerPid` Never Set on VMHandle

**Impact**: The PID-based VM termination path in `destroyFirecrackerVM` is always a no-op. Falls back to `pkill -f`, which works but is less precise. More critically, crash recovery checks PID liveness via `kill(pid, 0)` — with pid always undefined, all orphaned VMs appear dead.

In `worker/src/vm/firecracker.ts`, the `fcProcess` returned by `execFileAsync` is a Promise, and its PID is never extracted and stored on the handle.

**Fix**: After spawning the Firecracker process, capture the child process PID and store it as `firecrackerPid` on the VMHandle. This requires switching from `execFileAsync` (which returns stdout/stderr) to `spawn` or `execFile` with access to the `ChildProcess` object.

**Files**: `worker/src/vm/firecracker.ts`

---

### B6. HMAC Secret Inconsistency Between Dispatch and Verification

**Impact**: Per-job HMAC verification (Security H6) silently fails in the most likely deployment configuration.

`convex/pipelines/dispatchVerification.ts:16` generates the HMAC using `process.env.WORKER_SHARED_SECRET || process.env.WORKER_API_SECRET || ""`. But `convex/http.ts:1617` verifies with only `process.env.WORKER_SHARED_SECRET || ""`. If an operator sets only `WORKER_API_SECRET` (which `.env.example` documents), the HMAC is generated with `WORKER_API_SECRET` but verified against an empty string — so verification always fails silently and the HMAC check is skipped (it's optional, gated by `if (body.jobHmac)`).

**Fix**: Unify on a single environment variable name. Recommended: use `WORKER_SHARED_SECRET` everywhere. Update `convex/pipelines/dispatchVerification.ts`, `convex/devWorkspaces.ts`, and `convex/aws.ts` to read `WORKER_SHARED_SECRET` (with `WORKER_API_SECRET` as a deprecated fallback). Update `.env.example` and `setup.md` to match.

**Files**: `convex/pipelines/dispatchVerification.ts`, `convex/devWorkspaces.ts`, `convex/aws.ts`, `.env.example`, `setup.md`

---

### B7. `WORKER_SHARED_SECRET` Missing from `.env.example`

**Impact**: Any operator deploying from the example file won't set this variable. All incoming worker verification result callbacks to `POST /api/verification/result` will return 401. The entire verification pipeline breaks silently.

**Fix**: Add `WORKER_SHARED_SECRET` to `.env.example` in both the Convex and Worker sections, with a clear comment explaining it's the shared secret for worker-to-Convex authentication.

**Files**: `.env.example`, `setup.md`

---

### B8. vsock-agent Binary Not Pre-Built in Rootfs

**Impact**: `docker build` on `worker/rootfs/base.Dockerfile` fails at the `COPY vsock-agent /usr/local/bin/vsock-agent` step because the binary doesn't exist.

**Fix**: Document the build order in a root-level `Makefile` or `worker/rootfs/README.md`:
1. `cd worker/vsock-agent && make build` (produces `worker/rootfs/vsock-agent`)
2. Then build the Docker images

Alternatively, add a multi-stage Docker build that compiles the Go binary in a `golang:1.22-alpine` stage before the rootfs stage.

**Files**: `worker/vsock-agent/Makefile`, `worker/rootfs/base.Dockerfile` (or new `worker/rootfs/README.md`)

---

## 3. Required

These do not prevent the core flow from working but are needed for a credible, trustworthy v1 release.

### R1. `CLERK_WEBHOOK_SECRET` Soft Failure

**Impact**: If the `CLERK_WEBHOOK_SECRET` environment variable is missing, `convex/http.ts` logs an error but processes the webhook without signature verification. An attacker could forge Clerk webhook payloads to create/modify user accounts.

**Fix**: Change the handler to return a 500 error if the secret is not configured, rather than proceeding without verification. Also add `CLERK_WEBHOOK_SECRET` to `.env.example`.

**Files**: `convex/http.ts` (~line 28-40), `.env.example`

---

### R2. `FC_HARDEN_EGRESS` Must Default to True in Production

**Impact**: Firecracker VMs have unconstrained outbound network access unless an operator explicitly sets `FC_HARDEN_EGRESS=true`. This violates the non-exfiltration guarantee — agents could send code to external servers.

**Fix**: Either default to `true` in production (detect via `NODE_ENV`), or add a prominent warning in `setup.md` and `.env.example` that this MUST be set to `true` for any deployment where real code is involved.

**Files**: `worker/src/vm/firecracker.ts` or `setup.md` + `.env.example`

---

### R3. Missing Environment Variables in `.env.example`

**Impact**: Operators deploying from the example file will miss required configuration.

| Variable | Used In | Why It's Needed |
|---|---|---|
| `CLERK_WEBHOOK_SECRET` | `convex/http.ts` | Clerk webhook signature verification |
| `WORKER_HOST_URL` | `worker/src/workspace/routes.ts` | Worker's externally-reachable URL |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Bounty detail share button | Social sharing link base URL |
| `GITHUB_BOT_TOKEN` | `convex/bountyClaims.ts` | Branch cleanup after claim completion |

**Fix**: Add all four to `.env.example` with descriptive comments.

**Files**: `.env.example`

---

### R4. "My Bounties" and "My Submissions" Sidebar Links Broken

**Impact**: Dashboard sidebar links navigate to `/bounties?mine=true` and `/bounties?submissions=true`, but the `useBountyFilters` hook doesn't read the `mine` or `submissions` query parameters. Both links land on the unfiltered bounties list.

**Fix**: Update `useBountyFilters` (or the bounties page component) to read and handle the `mine` and `submissions` query params, filtering the bounty list accordingly.

**Files**: `src/app/(dashboard)/bounties/page.tsx` or the `useBountyFilters` hook

---

### R5. Share Button Generates Broken Links

**Impact**: The `ShareBountyButton` on bounty detail builds a URL using `NEXT_PUBLIC_CONVEX_SITE_URL` (which defaults to empty string) and links to `/public/bounty?id=xxx` (which is a 404 — no such route exists).

**Fix**: Either remove the share button for v1 (simplest) or add `NEXT_PUBLIC_CONVEX_SITE_URL` to `.env.example` and create a `/public/bounty` route that shows a public bounty view.

**Files**: `src/app/(dashboard)/bounties/[id]/page.tsx`

---

### R6. SSH Fallback Uses Undefined Constants

**Impact**: If `FC_USE_VSOCK=false`, the worker throws a `ReferenceError` at runtime because `SSH_KEY_PATH` and `GUEST_SSH_PORT` are never declared in `worker/src/vm/firecracker.ts`.

**Fix**: Either define these constants (with sensible defaults) or remove the SSH fallback code entirely if vsock is the only supported transport for v1.

**Files**: `worker/src/vm/firecracker.ts`

---

### R7. Worker `.env.example` Files

**Impact**: Neither the worker nor the MCP server has a `.env.example` file. Operators must read source code to discover required environment variables.

**Fix**: Create `worker/.env.example` and `mcp-server/.env.example` listing all required and optional environment variables with comments.

**Files**: `worker/.env.example` (new), `mcp-server/.env.example` (new)

---

### R8. Stripe Payment Intent Failure Notification

**Impact**: When a Stripe `payment_intent.payment_failed` webhook fires, the handler only logs a warning. The bounty creator receives no in-app notification that their payment failed and the escrow is still unfunded.

**Fix**: In the Stripe webhook handler, create a notification record (or at minimum update the bounty with an error message visible to the creator).

**Files**: `convex/http.ts` (Stripe webhook handler section)

---

## 4. Explicitly Out of Scope for v1

These features exist as stubs, are partially implemented, or have been requested — but are **not needed for the MVP flow** and must not delay launch.

| Feature | Current State | Why It's Post-MVP |
|---|---|---|
| **Web3 / crypto payments** | Stubbed with "Coming Soon" in UI, guarded at creation | Alternative payment rail, not core flow |
| **Dispute resolution** | `disputed` status in state machine, no UI or mutations | Requires arbitration design; v1 uses automated verification |
| **Admin panel** | Sidebar link points to settings | Admin ops can use Convex dashboard directly |
| **GitHub App integration** | Uses PATs; works but lower rate limits | PATs are sufficient for early users |
| **Multi-language rootfs** | Only Node.js 20 rootfs exists | Python/Rust/Go/Java images are additive |
| **External monitoring (APM)** | Winston logs to stdout | Log aggregation can be added via Docker log drivers |
| **Integration / e2e tests** | Unit tests exist; no full-lifecycle test | Manual testing sufficient for v1 launch |
| **Tool profiles per connection** | Profiles defined, not wired into registration | All agents use canonical tool names; aliases are cosmetic |
| **Agent claims via web UI** | Claims are MCP-only | Agents are the target users; they use MCP |
| **Notification types beyond `new_bounty`** | Schema hardcodes `v.literal("new_bounty")` | Claim/payout notifications are nice-to-have |
| **`claimDurationHours` in create mutation** | Field in schema, absent from create args | Default 4h window works for v1 |
| **Zod version unification** | v3 in mcp-server, v4 in root | No runtime conflict; cosmetic inconsistency |

---

## 5. Environment Variable Audit

Complete list of environment variables that must be set for a production deployment. Variables marked **NEW** must be added to `.env.example`.

### Next.js Frontend (`.env.local`)

| Variable | Required | In `.env.example` |
|---|---|---|
| `NEXT_PUBLIC_CONVEX_URL` | Yes | Yes |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes | Yes |
| `CLERK_SECRET_KEY` | Yes | Yes |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Yes | Yes |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Yes | Yes |
| `CLERK_JWT_ISSUER_DOMAIN` | Yes | Yes |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | For share links | **NEW** |

### Convex Backend (`npx convex env set`)

| Variable | Required | In `.env.example` |
|---|---|---|
| `STRIPE_SECRET_KEY` | Yes | Yes |
| `STRIPE_WEBHOOK_SECRET` | Yes | Yes |
| `APP_URL` | Yes | Yes |
| `CLERK_WEBHOOK_SECRET` | Yes | **NEW** |
| `WORKER_SHARED_SECRET` | Yes | **NEW** |
| `WORKER_API_SECRET` | Deprecated — use `WORKER_SHARED_SECRET` | Yes (rename) |
| `WORKER_API_URL` | Yes | Yes |
| `MCP_SHARED_SECRET` | No (dev only) | Yes |
| `GITHUB_API_TOKEN` | Yes | Yes |
| `GITHUB_BOT_TOKEN` | For branch cleanup | **NEW** |
| `GITHUB_WEBHOOK_SECRET` | Yes | Yes |
| `ANTHROPIC_API_KEY` | For AI test gen | Yes |
| `OPENAI_API_KEY` | Fallback | Yes |
| `VOYAGE_AI_API_KEY` | For embeddings | Yes |
| `CONVEX_URL` | For self-reference | Yes |

### Worker (`worker/.env`)

| Variable | Required | In `.env.example` |
|---|---|---|
| `WORKER_SHARED_SECRET` | Yes | **NEW file** |
| `CONVEX_URL` | Yes | **NEW file** |
| `REDIS_URL` | Yes (default: `redis://127.0.0.1:6379`) | **NEW file** |
| `WORKER_HOST_URL` | Yes | **NEW file** |
| `PORT` | No (default: 3001) | **NEW file** |
| `FC_USE_VSOCK` | No (default: true) | **NEW file** |
| `FC_HARDEN_EGRESS` | Must be `true` in production | **NEW file** |
| `SNYK_TOKEN` | Optional (gate skipped if absent) | **NEW file** |
| `SONARQUBE_URL` | Optional (gate skipped if absent) | **NEW file** |
| `SONARQUBE_TOKEN` | Optional (gate skipped if absent) | **NEW file** |

### MCP Server (npm package — not operator-hosted)

The MCP server is published as the `arcagent-mcp` npm package and runs on agent machines, not operator infrastructure. Agents only need `ARCAGENT_API_KEY` (set in their Claude Desktop config). The variables below are only for running the MCP server from source during development:

| Variable | Required | In `.env.example` |
|---|---|---|
| `CONVEX_URL` | Dev only (defaults to production in published package) | Yes |
| `MCP_SHARED_SECRET` | Dev only (or `ARCAGENT_API_KEY`) | Yes |
| `ARCAGENT_API_KEY` | Agents set this in Claude Desktop config | Yes |
| `WORKER_SHARED_SECRET` | Dev only, for workspace tools | Yes |
| `WORKER_HOST_URL` | Dev only, for workspace tools | **NEW** |
| `MCP_TRANSPORT` | No (default: stdio) | Yes |
| `MCP_PORT` | No (default: 3002) | Yes |
| `CLERK_SECRET_KEY` | Dev only, for agent registration | Yes |

---

## 6. Verification Checklist

When all items below are checked, the application is ready for v1 release.

### Blockers

- [ ] **B1** — Fund Escrow button added to bounty detail page; creator can fund + publish via web UI
- [ ] **B2** — `sessionStore.save()` called from `provisionWorkspace()`; sessions persist to Redis
- [ ] **B3** — Worker startup calls `generateWorkerInstanceId()`, `recoverOrphanedSessions()`, `startWorkerHeartbeat()`
- [ ] **B4** — `startMonitoring()` called on workspace ready; `stopMonitoring()` on destroy; `stopAll()` on shutdown
- [ ] **B5** — Firecracker PID captured and stored on VMHandle
- [ ] **B6** — Secret naming unified to `WORKER_SHARED_SECRET` across all Convex files
- [ ] **B7** — `WORKER_SHARED_SECRET` added to `.env.example`
- [ ] **B8** — vsock-agent build step documented or integrated into rootfs Dockerfile

### Required

- [ ] **R1** — `CLERK_WEBHOOK_SECRET` missing → handler returns 500 instead of proceeding unsigned
- [ ] **R2** — `FC_HARDEN_EGRESS` documented as required `true` for production; or default changed
- [ ] **R3** — Missing env vars added to `.env.example` (`CLERK_WEBHOOK_SECRET`, `WORKER_HOST_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL`, `GITHUB_BOT_TOKEN`)
- [ ] **R4** — "My Bounties" / "My Submissions" sidebar links filter correctly
- [ ] **R5** — Share button either removed or fixed with proper route + env var
- [ ] **R6** — SSH fallback constants defined or SSH code path removed
- [ ] **R7** — `worker/.env.example` and `mcp-server/.env.example` created
- [ ] **R8** — Stripe payment failure creates a creator-visible notification or error message

### Smoke Test

After all fixes, this end-to-end test must pass manually:

1. **Creator flow**: Sign up → Create bounty with BDD tests → Fund escrow via Stripe → Publish bounty → Verify it appears in the bounty explorer
2. **Agent flow**: Generate API key in Settings > API Keys → Configure `npx arcagent-mcp` with `ARCAGENT_API_KEY` → List bounties → Claim bounty → Verify workspace provisions → Read/edit files in workspace → Submit solution
3. **Verification flow**: Submission triggers 8-gate pipeline → Gates run in Firecracker VM → Results posted back to Convex → Verification status visible on submission page
4. **Payout flow**: Passed verification → Escrow released → Payment record created → Bounty marked completed
5. **Resilience**: Kill worker process → Restart → Verify orphaned sessions are recovered or cleaned up
