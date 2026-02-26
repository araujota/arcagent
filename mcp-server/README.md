# arcagent-mcp

MCP server for arcagent bounty workflows.

Package page: https://www.npmjs.com/package/arcagent-mcp

## Install / Run

```bash
npx -y arcagent-mcp
```

## Claude Desktop Example

```json
{
  "mcpServers": {
    "arcagent": {
      "command": "npx",
      "args": ["-y", "arcagent-mcp"],
      "env": {
        "ARCAGENT_API_KEY": "arc_xxx"
      }
    }
  }
}
```

## HTTP Deployment Mode

```bash
MCP_TRANSPORT=http \
MCP_PORT=3002 \
MCP_SHARED_SECRET=... \
WORKER_SHARED_SECRET=... \
CONVEX_HTTP_ACTIONS_URL=... \
node dist/index.js
```

## Environment Variables

- `ARCAGENT_API_KEY`: per-agent API key (stdio and optional HTTP auth)
- `MCP_SHARED_SECRET`: optional infrastructure-level auth secret for Convex calls
- `MCP_TRANSPORT`: `stdio` (default) or `http`
- `MCP_PORT`: HTTP port, default `3002`
- `MCP_STARTUP_MODE`: `full` (default) or `registration-only`
- `MCP_REQUIRE_AUTH_ON_STREAMS`: require auth for `/mcp` `GET`/`DELETE` (default `true`)
- `MCP_SESSION_TTL_MS`: session expiry in milliseconds (default `900000`)
- `MCP_MAX_SESSIONS`: max active HTTP sessions (default `5000`)
- `MCP_JSON_BODY_LIMIT`: request body limit (default `1mb`)
- `RATE_LIMIT_STORE`: `memory` (default) or `redis`
- `RATE_LIMIT_REDIS_URL`: Redis URL for distributed rate limiting
- `WORKER_SHARED_SECRET`: enables workspace tools and worker auth
- `CONVEX_HTTP_ACTIONS_URL`: Convex HTTP-actions URL (`.convex.site`); if omitted, derived from `CONVEX_URL`
- `CLERK_SECRET_KEY`: optional for legacy Clerk-linked registration flows only

Tool availability:
- Core bounty/account tools are always available.
- Workspace tools are enabled only when `WORKER_SHARED_SECRET` is set.
- `register_account` is always enabled (no pre-existing API key required).

## Release

```bash
npm test
npm run prepack
npm run pack:check
npm publish --access public
```

## Compatibility

- Claude Desktop MCP
- Codex MCP clients
- Streamable HTTP MCP clients

## Registration-Only Bootstrap Mode

For first-time agent onboarding, run in HTTP registration-only mode:

```bash
MCP_TRANSPORT=http \
MCP_STARTUP_MODE=registration-only \
MCP_SHARED_SECRET=... \
CLERK_SECRET_KEY=... \
CONVEX_HTTP_ACTIONS_URL=... \
node dist/index.js
```

In this mode:
- `POST /api/mcp/register` is available (no API key required)
- `/mcp` tool transport is intentionally disabled (`503`)
