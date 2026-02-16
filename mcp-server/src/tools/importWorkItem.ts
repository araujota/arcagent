import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";

/**
 * Inline types for work items (avoids importing from convex/ which is outside rootDir).
 */
interface WorkProviderConfig {
  provider: "jira" | "linear" | "asana" | "monday";
  domain?: string;
  email?: string;
  apiToken: string;
}

interface WorkItem {
  externalId: string;
  provider: string;
  title: string;
  description: string;
  acceptanceCriteria?: string;
  labels: string[];
  estimate?: number;
  status: string;
  priority?: string;
  url: string;
}

/**
 * Lightweight fetch functions for each provider.
 * These are simplified versions that run in the MCP server process.
 */
async function fetchJira(config: WorkProviderConfig, key: string): Promise<WorkItem> {
  if (!config.domain || !config.email) throw new Error("Jira requires domain and email");
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
  const res = await fetch(`https://${config.domain}/rest/api/3/issue/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${res.statusText}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await res.json()) as Record<string, any>;
  const f = data.fields || {};
  const desc = typeof f.description === "string" ? f.description : JSON.stringify(f.description || "");
  return {
    externalId: key, provider: "jira", title: f.summary || "", description: desc,
    labels: (f.labels || []) as string[], status: f.status?.name || "Unknown",
    priority: f.priority?.name, url: `https://${config.domain}/browse/${key}`,
  };
}

async function fetchLinear(config: WorkProviderConfig, key: string): Promise<WorkItem> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: config.apiToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query { issues(filter: { identifier: { eq: "${key}" } }, first: 1) { nodes { identifier title description url estimate priorityLabel state { name } labels { nodes { name } } } } }`,
    }),
  });
  if (!res.ok) throw new Error(`Linear ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await res.json()) as Record<string, any>;
  const issue = result.data?.issues?.nodes?.[0];
  if (!issue) throw new Error(`Not found: ${key}`);
  return {
    externalId: issue.identifier, provider: "linear", title: issue.title || "",
    description: issue.description || "",
    labels: (issue.labels?.nodes || []).map((l: { name: string }) => l.name),
    estimate: issue.estimate, status: issue.state?.name || "Unknown",
    priority: issue.priorityLabel, url: issue.url || "",
  };
}

async function fetchAsana(config: WorkProviderConfig, gid: string): Promise<WorkItem> {
  const res = await fetch(`https://app.asana.com/api/1.0/tasks/${gid}?opt_fields=name,notes,tags.name,permalink_url`, {
    headers: { Authorization: `Bearer ${config.apiToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Asana ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await res.json()) as Record<string, any>;
  const t = result.data;
  return {
    externalId: gid, provider: "asana", title: t.name || "", description: t.notes || "",
    labels: (t.tags || []).map((tag: { name: string }) => tag.name), status: "Unknown",
    url: t.permalink_url || "",
  };
}

async function fetchMonday(config: WorkProviderConfig, id: string): Promise<WorkItem> {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { Authorization: config.apiToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query { items(ids: [${id}]) { id name url column_values { title text type } } }`,
    }),
  });
  if (!res.ok) throw new Error(`Monday ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await res.json()) as Record<string, any>;
  const item = result.data?.items?.[0];
  if (!item) throw new Error(`Not found: ${id}`);
  let desc = "";
  for (const col of item.column_values || []) {
    if ((col.type === "long_text" || col.type === "long-text") && col.text) { desc = col.text; break; }
  }
  return {
    externalId: id, provider: "monday", title: item.name || "", description: desc,
    labels: [], status: "Unknown", url: item.url || "",
  };
}

async function fetchWorkItemForMcp(
  provider: "jira" | "linear" | "asana" | "monday",
  config: WorkProviderConfig,
  key: string
): Promise<WorkItem> {
  switch (provider) {
    case "jira": return fetchJira(config, key);
    case "linear": return fetchLinear(config, key);
    case "asana": return fetchAsana(config, key);
    case "monday": return fetchMonday(config, key);
  }
}

export function registerImportWorkItem(server: McpServer): void {
  registerTool(
    server,
    "import_work_item",
    "Import a work item (issue/task/story) from Jira, Linear, Asana, or Monday.com. Returns structured data that can be used to pre-fill a bounty.",
    {
      provider: z.enum(["jira", "linear", "asana", "monday"]).describe("PM tool provider"),
      issueKey: z.string().describe("Issue identifier (e.g., 'PROJ-123' for Jira, 'TEAM-123' for Linear, GID for Asana, item ID for Monday)"),
      apiToken: z.string().describe("API token for the PM tool (sensitive — not stored after this request)"),
      domain: z.string().optional().describe("Required for Jira (e.g., 'mycompany.atlassian.net') and Monday (account slug)"),
      email: z.string().optional().describe("Required for Jira (email for Basic Auth)"),
    },
    async (args: {
      provider: "jira" | "linear" | "asana" | "monday";
      issueKey: string;
      apiToken: string;
      domain?: string;
      email?: string;
    }) => {
      requireScope("bounties:create");
      const authUser = getAuthUser();
      if (!authUser?.userId) {
        return {
          content: [{ type: "text" as const, text: "Error: Authentication required." }],
          isError: true,
        };
      }

      try {
        const config: WorkProviderConfig = {
          provider: args.provider,
          domain: args.domain,
          email: args.email,
          apiToken: args.apiToken,
        };

        const workItem = await fetchWorkItemForMcp(args.provider, config, args.issueKey);

        let text = `# Work Item Imported\n\n`;
        text += `**Provider:** ${args.provider}\n`;
        text += `**ID:** ${workItem.externalId}\n`;
        text += `**Title:** ${workItem.title}\n`;
        text += `**Status:** ${workItem.status}\n`;
        if (workItem.priority) text += `**Priority:** ${workItem.priority}\n`;
        if (workItem.estimate) text += `**Estimate:** ${workItem.estimate} points\n`;
        if (workItem.labels.length > 0) text += `**Labels:** ${workItem.labels.join(", ")}\n`;
        text += `**URL:** ${workItem.url}\n\n`;
        text += `## Description\n\n${workItem.description || "No description"}\n`;
        if (workItem.acceptanceCriteria) {
          text += `\n## Acceptance Criteria\n\n${workItem.acceptanceCriteria}\n`;
        }
        text += `\n---\nUse \`create_bounty\` with this information to create a bounty. `;
        text += `Pass \`pmIssueKey: "${workItem.externalId}"\` and \`pmProvider: "${args.provider}"\` for traceability.`;

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to import work item";
        return {
          content: [{ type: "text" as const, text: `Failed to import work item: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
