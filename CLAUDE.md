# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Root — Next.js frontend + Convex backend
npm run dev              # Starts Next.js (port 3000) + Convex dev server in parallel
npm run dev:next         # Next.js only
npm run dev:convex       # Convex only
npm run build            # Next.js production build
npm run lint             # ESLint
npm run seed             # Seed DB: convex run seed:seed
npx tsc --noEmit         # Type-check (convex files have pre-existing implicit any errors)

# Worker — verification pipeline (port 3001)
cd worker && npm run dev      # tsx watch
cd worker && npm run build    # tsc

# MCP Server — npm package for self-host + HTTP runtime for operator-hosted deployment
cd mcp-server && npm run dev                     # stdio transport (local dev)
cd mcp-server && MCP_TRANSPORT=http npm run dev   # HTTP transport (local dev)
cd mcp-server && npm run build                    # Build for publishing
```

**Note:** `next build` requires `typescript.ignoreBuildErrors: true` in `next.config.ts` because convex files use `strict: true` but have widespread implicit `any` parameters. This is a known pre-existing issue.

## Architecture

Three operator-deployed services plus one npm package, no workspace tooling — each has its own `package.json`:

**Next.js App** (`src/`) — React 19 + App Router + shadcn/ui. Auth via Clerk. Real-time data via Convex `useQuery`/`useMutation`. Route groups: `(auth)` for sign-in, `(dashboard)` for authenticated pages, `(marketing)` for public pages. Clerk + Convex wired in `src/app/providers.tsx` via `ConvexProviderWithClerk`.

**Convex Backend** (`convex/`) — Database, serverless functions, HTTP endpoints. Schema in `convex/schema.ts`. Functions are `query`/`mutation` (public, Clerk-authed) or `internalQuery`/`internalMutation`/`internalAction` (server-to-server, no Clerk). Actions can call external APIs (LLM, Stripe, GitHub). HTTP routes in `convex/http.ts` handle webhooks (Clerk, GitHub, Stripe) and MCP/worker endpoints authenticated via shared secrets or API keys.

**Worker** (`worker/`) — Express + BullMQ + Redis. Receives verification jobs from Convex, runs the 8-gate pipeline inside Firecracker microVMs, posts results back to `POST /api/verification/result`. Each job is HMAC-signed to prevent forged results.

**MCP Server** (`mcp-server/`) — Published as the `arcagent-mcp` npm package for self-hosted agent usage (`npx arcagent-mcp`) and also deployable as an operator-hosted HTTPS endpoint (`https://mcp.arcagent.dev`). Auth: API key → bearer token → Convex HTTP endpoint → SHA-256 hash → DB lookup. In stdio mode, auth context is set at startup; in HTTP mode, per-request via AsyncLocalStorage.

## Key Patterns

### Convex auth
Public functions use `requireAuth(await getCurrentUser(ctx))` which validates the Clerk JWT. Internal functions skip this — auth is handled at the HTTP layer (shared secrets). The helper `requireBountyAccess(ctx, bountyId)` enforces row-level access by role (admin/creator/agent).

### Convex function types
- `query`/`mutation` — client-callable, Clerk-authed
- `internalQuery`/`internalMutation` — only callable from other Convex functions or `ctx.scheduler`
- `action`/`internalAction` — can call external APIs (fetch, Stripe, LLM), can call queries/mutations via `ctx.runQuery`/`ctx.runMutation`

### MCP tool registration
Each tool is a file in `mcp-server/src/tools/` exporting `registerXxx(server)`. Tools use `requireScope("bounties:claim")` for permission checks and `getAuthUser()` (from AsyncLocalStorage) for identity — never accept userId as a parameter.

### Escrow state machine
`unfunded → funded → released | refunded`. No backwards transitions. Enforced in `convex/stripe.ts` via `VALID_ESCROW_TRANSITIONS`.

### Bounty status transitions
`draft → active → in_progress → completed`. Also: `active/in_progress/disputed → cancelled`. Terminal states: `completed`, `cancelled`. Enforced via `VALID_STATUS_TRANSITIONS` in `convex/bounties.ts`.

### Verification pipeline (worker)
8 gates run sequentially: build (fail-fast) → lint → typecheck → security → memory → snyk → sonarqube → test (fail-fast). Gate runner in `worker/src/gates/gateRunner.ts`. Each gate returns `{ status: "passed"|"failed"|"warning", summary, details }`. Snyk and SonarQube are optional per bounty creator settings.

### Cancellation guards
`cancelBountyImpl()` blocks if: bounty is completed/cancelled, an active claim exists, or any submission is pending/running. On cancel: sets status to `cancelled`, schedules Stripe refund if funded, schedules repo data cleanup.

## Security Annotations

The codebase uses inline security annotations (e.g., `SECURITY (H4)`, `SECURITY (C1)`) to mark security-critical code. Key ones:
- **C1**: Agent identity from auth context, not parameters
- **C3**: Escrow state machine guards
- **H3**: Constant-time secret comparison
- **H4**: API key scope enforcement
- **H6**: Per-job HMAC verification
- **M2**: Escrow release blocked if bounty cancelled
- **M12**: Reject late verification results for timed-out jobs
