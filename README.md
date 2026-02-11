This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Environment Variables

The project has three services, each with their own environment configuration. Copy `.env.example` to `.env.local` and fill in the values.

### Frontend (Next.js) — `.env.local`

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_CONVEX_URL` | Yes | Convex deployment URL |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable key |
| `CLERK_SECRET_KEY` | Yes | Clerk secret key |
| `CLERK_JWT_ISSUER_DOMAIN` | Yes | Clerk JWT issuer domain |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Yes | Sign-in page path (default: `/sign-in`) |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Yes | Sign-up page path (default: `/sign-up`) |

### Convex Backend — set via `npx convex env set KEY VALUE`

| Variable | Required | Description |
|----------|----------|-------------|
| `CLERK_WEBHOOK_SECRET` | Yes | Svix signing secret for Clerk webhooks |
| `GITHUB_API_TOKEN` | Yes | GitHub PAT for repo fetching (5K req/hr) |
| `ANTHROPIC_API_KEY` | Yes | Claude API key for the NL→BDD→TDD pipeline |
| `LLM_PROVIDER` | No | `anthropic` (default) or `openai` |
| `LLM_MODEL` | No | Model ID (default: `claude-sonnet-4-5-20250929`) |
| `OPENAI_API_KEY` | No | OpenAI key (fallback embeddings + optional LLM) |
| `VOYAGE_AI_API_KEY` | No | Voyage Code-2 embeddings (best for code retrieval) |
| `QDRANT_URL` | No | Qdrant vector store endpoint |
| `QDRANT_API_KEY` | No | Qdrant auth (if using Qdrant Cloud) |
| `WORKER_API_URL` | No | Verification worker HTTP endpoint |
| `WORKER_API_SECRET` | No | Shared secret for worker ↔ Convex auth |
| `MCP_SHARED_SECRET` | No* | Shared secret for MCP server ↔ Convex auth |

> \* `MCP_SHARED_SECRET` is required if you are running the MCP server.

### Verification Worker — `worker/.env`

| Variable | Required | Description |
|----------|----------|-------------|
| `CONVEX_URL` | Yes | Convex deployment URL |
| `CONVEX_DEPLOY_KEY` | Yes | Convex deploy key for posting results |
| `WORKER_SHARED_SECRET` | Yes | Must match `WORKER_API_SECRET` in Convex env |
| `REDIS_URL` | Yes | Redis connection URL (default: `redis://localhost:6379`) |
| `GITHUB_API_TOKEN` | Yes | GitHub PAT for cloning repos in the VM |
| `SONARQUBE_URL` | No | SonarQube endpoint (optional gate) |
| `SONARQUBE_TOKEN` | No | SonarQube auth token |

### MCP Server — `mcp-server/.env`

The MCP server is a standalone Node.js service that exposes the bounty lifecycle to MCP-compatible AI agents (Claude Desktop, Claude Code, custom agent frameworks).

| Variable | Required | Description |
|----------|----------|-------------|
| `CONVEX_URL` | Yes | Convex deployment URL |
| `MCP_SHARED_SECRET` | Yes | Must match `MCP_SHARED_SECRET` in Convex env |
| `MCP_TRANSPORT` | No | `stdio` (default, for local clients) or `http` (for remote clients) |
| `MCP_PORT` | No | HTTP transport port (default: `3002`) |
| `GITHUB_BOT_TOKEN` | No* | GitHub App or PAT with `repo` + `org` scope for creating forks |
| `GITHUB_MIRROR_ORG` | No* | GitHub org for mirror forks (e.g. `arcagent-mirrors`) |

> \* `GITHUB_BOT_TOKEN` and `GITHUB_MIRROR_ORG` are required if agents will use the `claim_bounty` tool with repository forking enabled.

#### Running the MCP server

```bash
cd mcp-server
npm install
npm run dev          # stdio mode (for local MCP clients)
MCP_TRANSPORT=http npm run dev   # HTTP mode (for remote clients)
```

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
