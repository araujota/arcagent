# MCP Server Runbook

## Runtime Modes

- Self-hosted/local: `npx -y arcagent-mcp` (stdio default)
- Operator-hosted: HTTP transport behind HTTPS (`https://mcp.arcagent.dev`)

Feature parity must be maintained across both modes.
Publish `https://mcp.arcagent.dev` as the MCP server URL for remote clients.

## Hosted Deployment Topology

Target stack: `infra/aws-mcp/`

- ECS Fargate service (desired count >= 2)
- ALB with `80 -> 443` redirect and HTTPS listener
- ACM certificate for `mcp.arcagent.dev`
- ElastiCache Redis for distributed rate limiting
- CloudWatch logs and alarms
- Optional WAF association

## DNS Ownership Model (Vercel + AWS)

Domain ownership stays in Vercel. Do not transfer registrar/zone ownership.

1. Request or provide ACM certificate in `us-east-1`.
2. Add ACM DNS validation CNAME records in Vercel DNS.
3. Add `mcp.arcagent.dev` CNAME in Vercel DNS -> AWS ALB DNS name.

## Release Stages

1. Push canary npm tag (trusted publishing workflow):
```bash
VERSION=$(node -p "require('./mcp-server/package.json').version")
git tag "mcp-server-v${VERSION}-next"
git push origin "mcp-server-v${VERSION}-next"
```
2. Deploy hosted image canary (ECS rolling update).
3. Validate for 24h:
- auth failure rate
- rate-limit denials
- session-mode errors
- p95 request and tool latency
- register success/failure ratio
4. Promote stable npm tag:
```bash
git tag "mcp-server-v<version>"
git push origin "mcp-server-v<version>"
```
5. Promote/demote dist-tags as needed:
```bash
npm dist-tag add arcagent-mcp@<version> latest
```

## Trusted Publishing Setup (One-Time in npm)

1. npm package settings -> `arcagent-mcp` -> Trusted publishers.
2. Add GitHub Actions publisher:
- owner/repo: `araujota/arcagent`
- workflow file: `.github/workflows/publish-mcp.yml`
- environment: optional if enforced in GitHub.
3. Keep package 2FA policy enabled.

## Required Hosted Env

- `MCP_TRANSPORT=http`
- `MCP_PUBLIC_BASE_URL=https://mcp.arcagent.dev`
- `MCP_ALLOWED_HOSTS=mcp.arcagent.dev`
- `MCP_REQUIRE_HTTPS=true`
- `MCP_SESSION_MODE=stateful` (phase A)
- `RATE_LIMIT_STORE=redis`
- `RATE_LIMIT_REDIS_URL=redis://...`
- `MCP_ENABLE_CONVEX_AUDIT_LOGS=true`
- `MCP_AUDIT_LOG_TOKEN=<secret>`

## Session-Mode Rollout

Phase A (launch):
- `MCP_SESSION_MODE=stateful`
- ALB stickiness enabled

Phase B (migration):
- set `MCP_SESSION_MODE=stateless`
- canary clients first
- monitor compatibility and latency
- rollback by restoring `stateful`

## Key Rotation

1. Rotate `WORKER_SHARED_SECRET` + `MCP_AUDIT_LOG_TOKEN` in Secrets Manager.
2. Roll out Convex + worker + MCP in that order.
3. Validate `/health` and `/metrics`.

## Incident Response

1. Identify blast radius from CloudWatch logs + `/metrics`.
2. For auth/session issues:
- confirm host/proto headers and ALB forwarding
- verify session mode matches client expectations
3. For abuse spikes:
- tighten rate limits and registration controls
- enable/adjust WAF

## Rollback

Hosted runtime rollback:
1. Revert ECS task definition image/environment to last known good.
2. If stateless migration caused issues, set `MCP_SESSION_MODE=stateful`.

Package rollback:
1. Pin clients:
```bash
npx -y arcagent-mcp@<previous_version>
```
2. Reassign dist-tag if needed:
```bash
npm dist-tag add arcagent-mcp@<previous_version> latest
```

## SLO Targets

- Availability: 99.9%
- p95 MCP request latency: < 500ms (excluding long-running tool execution)
- Auth failure ratio: < 2% baseline
- Invalid-session ratio: < 1% of stream traffic in stateful mode

## Compatibility Matrix

- Claude Desktop: stdio (`npx`) supported
- Codex clients: stdio or hosted HTTP supported
- Generic streamable HTTP clients: supported with bearer auth over HTTPS
