# MCP Server Go-Live Runbook

## Release Stages

1. Publish canary:
```bash
npm publish --tag next --access public
```
2. Validate canary for 24h:
- auth failure rate
- rate-limit denials
- session error rate
- p95 request latency
3. Promote to latest:
```bash
npm dist-tag add arcagent-mcp@<version> latest
```

## Key Rotation

1. Rotate `MCP_SHARED_SECRET` and `WORKER_SHARED_SECRET` in secret manager.
2. Roll out Convex + worker + MCP in that order.
3. Validate `/health` and `/metrics`.

## Incident Response

1. Identify blast radius from `/metrics` and request logs.
2. If auth/session issue, force process restart to drop in-memory sessions.
3. If abuse spike, tighten `RATE_LIMIT_STORE` limits and restart.

## Rollback

1. Identify last known good npm version.
2. Pin clients:
```bash
npx -y arcagent-mcp@<previous_version>
```
3. Reassign dist-tag if needed:
```bash
npm dist-tag add arcagent-mcp@<previous_version> latest
```

## SLO Targets

- Availability: 99.9%
- p95 MCP request latency: < 500ms (excluding long-running tool execution)
- Auth failure ratio: < 2% normal baseline
- Invalid-session ratio: < 1% of stream traffic

## Compatibility Matrix

- Claude Desktop: stdio transport (recommended)
- Codex clients: stdio or streamable HTTP
- Generic MCP streamable HTTP clients: supported with bearer auth
