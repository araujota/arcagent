# CODEMAPS — ArcAgent Codebase Index

CODEMAPS are function-level maps of each service. They let you answer "where is the code for X?" without reading source files. Use them to find the right file, understand responsibility boundaries, and trace a flow across services. Once you know which file to look at, open the source for implementation details.

---

## Index

| File | Service | Primary Question Answered | Key Source Files |
|------|---------|--------------------------|-----------------|
| [convex.md](./convex.md) | Convex Backend | What functions, tables, HTTP routes, and crons exist? | `convex/schema.ts`, `convex/http.ts`, `convex/crons.ts` |
| [worker.md](./worker.md) | Worker | How does the 8-gate pipeline work? How do VMs provision/destroy? | `worker/src/gates/gateRunner.ts`, `worker/src/vm/firecracker.ts`, `worker/src/queue/jobProcessor.ts` |
| [mcp-server.md](./mcp-server.md) | MCP Server | What tools are available? How does auth work? | `mcp-server/src/server.ts`, `mcp-server/src/auth/apiKeyAuth.ts` |
| [frontend.md](./frontend.md) | Next.js Frontend | What pages exist? How does data flow from Convex to the UI? | `src/app/(dashboard)/`, `src/app/providers.tsx` |

---

## Cross-Cutting Concerns

### Security Annotations Index

Every security-critical code block is tagged with an inline `SECURITY (Xn)` comment. Here are all active annotations and where they live:

| Code | Location | What it guards |
|------|----------|----------------|
| C1 | `convex/http.ts` (all MCP routes) | Agent identity from auth context, not request body |
| C3 | `convex/stripe.ts` | Escrow state machine — no backwards transitions |
| H1 | `convex/bounties.ts` | Stripe bounties cannot publish unfunded |
| H3 | `convex/lib/` | Constant-time comparison for shared secrets |
| H4 | `mcp-server/src/auth/apiKeyAuth.ts` | Scope enforcement per tool |
| H6 | `convex/http.ts` `/api/verification/result` | Per-job HMAC prevents forged results |
| H7 | `convex/submissions.ts` | Rate limit: 1 pending + 1 running; hard cap 5 total |
| M2 | `convex/verifications.ts` | Payout blocked if bounty cancelled |
| M5 | `convex/http.ts` | `gateSettings` from Convex DB only, never request body |
| M12 | `convex/http.ts` `/api/verification/result` | Late results rejected after timeout |
| W2 | `worker/src/queue/jobProcessor.ts` | Commands run as non-root `agent` user |
| W3 | `worker/src/workspace/validation.ts` | Path validation scoped to `/workspace/` |

### Shared Secrets and Who Uses Them

| Secret | Direction | Purpose |
|--------|-----------|---------|
| `WORKER_SHARED_SECRET` | Convex → Worker | Convex calls worker `POST /api/verify` |
| `WORKER_SHARED_SECRET` | Worker → Convex | Worker posts `POST /api/verification/result` |
| `WORKER_SHARED_SECRET` | MCP Server → Worker | MCP workspace tools call Worker directly |
| `MCP_SHARED_SECRET` | Internal only | Local dev: MCP calls Convex without an API key |
| `ARCAGENT_API_KEY` | Agent → MCP → Convex | Per-agent API key for all MCP operations |
| `CLERK_JWT_ISSUER_DOMAIN` | Browser → Convex | Validates Clerk JWTs in public functions |

### System Data Flow Summary

```
Browser ──Clerk JWT──► Convex ──────────────────────────────────► Stripe
                          │                                         │
                          │ HTTP POST /api/verify                   │ webhook
                          ▼                                         ▼
                       Worker ◄── BullMQ/Redis                   Convex
                          │                                         ▲
                          │ provisions/destroys                     │
                          ▼                                         │
                    Firecracker VM                                   │
                          │                                         │
                          └─── POST /api/verification/result ───────┘
                                        (HMAC signed)

AI Agent ──arc_ key──► MCP Server (local) ──arc_ key──► Convex
                            │
                            │ WORKER_SHARED_SECRET (workspace tools)
                            ▼
                          Worker ──► Firecracker VM (workspace)
```

### Function Type Reference (Convex)

| Type | Auth | Can call external APIs | Callable from |
|------|------|----------------------|--------------|
| `query` | Clerk JWT | No | Browser via `useQuery` |
| `mutation` | Clerk JWT | No | Browser via `useMutation` |
| `action` | Clerk JWT | Yes | Browser via `useAction` |
| `internalQuery` | None (internal) | No | Other Convex functions, `ctx.runQuery` |
| `internalMutation` | None (internal) | No | Other Convex functions, `ctx.runMutation` |
| `internalAction` | None (internal) | Yes | Schedulers, crons, other actions |
