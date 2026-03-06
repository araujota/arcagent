export const hostedMcpBaseUrl = "https://mcp.arcagent.dev";
export const hostedMcpTransportUrl = `${hostedMcpBaseUrl}/mcp`;
export const hostedMcpPackageUrl = "https://www.npmjs.com/package/arcagent-mcp";

export const remoteMountingSummary =
  `Use the full /mcp endpoint (${hostedMcpTransportUrl}) for clients that ask for a streamable HTTP URL. If a client asks for a hosted MCP server URL and says it performs discovery itself, start with the base origin (${hostedMcpBaseUrl}) instead.`;

export const connectionVariants = [
  {
    client: "Codex",
    summary:
      "Mount ArcAgent as a native remote MCP attachment with the full /mcp URL and an env-backed bearer token.",
  },
  {
    client: "Claude Code",
    summary:
      "Mount the hosted MCP server over HTTP and send Authorization: Bearer with your ArcAgent API key.",
  },
  {
    client: "OpenCode",
    summary:
      "Use the hosted /mcp URL and an Authorization header in opencode.json.",
  },
  {
    client: "Other remote MCP clients",
    summary:
      "Use the same hosted /mcp URL and bearer header, but follow your client's own config shape.",
  },
  {
    client: "Claude Desktop",
    summary:
      "Use the local stdio package today. The desktop remote connector flow is not the right fit for ArcAgent's API-key bearer auth.",
  },
  {
    client: "OpenClaw and ACP-style orchestrators",
    summary:
      "Mount ArcAgent in the underlying Codex, Claude Code, or OpenCode harness that OpenClaw launches instead of expecting a separate ArcAgent-specific OpenClaw mount.",
  },
] as const;

export function getGenericRemoteSnippet(apiKey: string) {
  return `{
  "mcpServers": {
    "arcagent": {
      "url": "${hostedMcpTransportUrl}",
      "headers": {
        "Authorization": "Bearer ${apiKey}"
      }
    }
  }
}`;
}

export function getSelfHostedSnippet(apiKey: string) {
  return `{
  "mcpServers": {
    "arcagent": {
      "command": "npx",
      "args": ["-y", "arcagent-mcp"],
      "env": {
        "ARCAGENT_API_KEY": "${apiKey}"
      }
    }
  }
}`;
}

export function getCodexRemoteSnippet(apiKey: string) {
  return `export ARCAGENT_API_KEY="${apiKey}"
codex mcp add arcagent --url ${hostedMcpTransportUrl} --bearer-token-env-var ARCAGENT_API_KEY`;
}

export function getClaudeCodeRemoteSnippet(apiKey: string) {
  return `export ARCAGENT_API_KEY="${apiKey}"
claude mcp add --transport http arcagent ${hostedMcpTransportUrl} --header "Authorization: Bearer $ARCAGENT_API_KEY"`;
}

export function getOpenCodeRemoteSnippet(apiKey: string) {
  return `{
  "mcp": {
    "arcagent": {
      "type": "remote",
      "url": "${hostedMcpTransportUrl}",
      "headers": {
        "Authorization": "Bearer ${apiKey}"
      }
    }
  }
}`;
}

export const agentDocsSetupGuide = `Getting started takes three steps:

1. Generate an API key in Settings > API Keys (or during onboarding)
2. Mount ArcAgent using the client shape your harness expects:

Codex
Use the full transport URL:
${hostedMcpTransportUrl}

export ARCAGENT_API_KEY="arc_..."
codex mcp add arcagent --url ${hostedMcpTransportUrl} --bearer-token-env-var ARCAGENT_API_KEY

Claude Code
Mount the hosted HTTP server directly:

export ARCAGENT_API_KEY="arc_..."
claude mcp add --transport http arcagent ${hostedMcpTransportUrl} --header "Authorization: Bearer $ARCAGENT_API_KEY"

OpenCode
Use the hosted /mcp URL plus an Authorization header in opencode.json:

{
  "mcp": {
    "arcagent": {
      "type": "remote",
      "url": "${hostedMcpTransportUrl}",
      "headers": {
        "Authorization": "Bearer arc_..."
      }
    }
  }
}

Claude Desktop
Use the local stdio package instead of the remote connector flow:

{
  "mcpServers": {
    "arcagent": {
      "command": "npx",
      "args": ["-y", "arcagent-mcp"],
      "env": {
        "ARCAGENT_API_KEY": "arc_..."
      }
    }
  }
}

OpenClaw and ACP-style orchestrators
Mount ArcAgent in the underlying Codex, Claude Code, or OpenCode harness configuration rather than expecting a separate ArcAgent-specific OpenClaw connector.

3. Restart your client after updating config.

${remoteMountingSummary}

Your ARCAGENT_API_KEY is the only credential needed. Core tools are always available; workspace tools require the platform operator to configure WORKER_SHARED_SECRET.`;
