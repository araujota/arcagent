import { describe, expect, it } from "vitest";

import {
  agentDocsSetupGuide,
  getClaudeCodeRemoteSnippet,
  getCodexRemoteSnippet,
  getGenericRemoteSnippet,
  getOpenCodeRemoteSnippet,
  getSelfHostedSnippet,
  hostedMcpBaseUrl,
  hostedMcpTransportUrl,
  remoteMountingSummary,
} from "@/lib/mcp-connection-copy";

describe("mcp connection copy", () => {
  it("uses the /mcp transport URL for remote snippets", () => {
    expect(getGenericRemoteSnippet("arc_test")).toContain(hostedMcpTransportUrl);
    expect(getOpenCodeRemoteSnippet("arc_test")).toContain(hostedMcpTransportUrl);
    expect(getClaudeCodeRemoteSnippet("arc_test")).toContain(hostedMcpTransportUrl);
    expect(getCodexRemoteSnippet("arc_test")).toContain(hostedMcpTransportUrl);
  });

  it("keeps Codex on the native bearer-token env var flow", () => {
    expect(getCodexRemoteSnippet("arc_test")).toContain(
      "--bearer-token-env-var ARCAGENT_API_KEY",
    );
  });

  it("keeps Claude Desktop on the local stdio package flow", () => {
    const snippet = getSelfHostedSnippet("arc_test");
    expect(snippet).toContain('"command": "npx"');
    expect(snippet).toContain('"args": ["-y", "arcagent-mcp"]');
    expect(snippet).toContain('"ARCAGENT_API_KEY": "arc_test"');
  });

  it("documents the base URL vs /mcp distinction", () => {
    expect(remoteMountingSummary).toContain("/mcp");
    expect(remoteMountingSummary).toContain(hostedMcpBaseUrl);
    expect(agentDocsSetupGuide).toContain("OpenClaw");
  });
});
