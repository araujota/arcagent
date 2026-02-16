import { WorkItem, WorkProviderConfig } from "./types";
import { adfToMarkdown } from "../adfToMarkdown";

/**
 * Fetch a Jira issue by key (e.g., "PROJ-123").
 * Auth: Basic Auth (email:apiToken base64-encoded).
 */
export async function fetchJiraIssue(
  config: WorkProviderConfig,
  issueKey: string
): Promise<WorkItem> {
  if (!config.domain) throw new Error("Jira domain is required");
  if (!config.email) throw new Error("Jira email is required");

  const auth = btoa(`${config.email}:${config.apiToken}`);

  const response = await fetch(
    `https://${config.domain}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    if (response.status === 404) throw new Error(`Issue not found: ${issueKey}`);
    if (response.status === 401) throw new Error("Invalid Jira credentials");
    throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await response.json() as Record<string, any>;
  const fields = data.fields;

  // Convert ADF description to Markdown
  let description = "";
  if (fields.description) {
    if (typeof fields.description === "string") {
      description = fields.description;
    } else {
      description = adfToMarkdown(fields.description);
    }
  }

  // Extract acceptance criteria from custom field or description
  let acceptanceCriteria: string | undefined;
  // Common custom field names for acceptance criteria
  for (const key of Object.keys(fields)) {
    if (key.startsWith("customfield_") && typeof fields[key] === "string") {
      if (fields[key].toLowerCase().includes("acceptance")) {
        acceptanceCriteria = fields[key];
        break;
      }
    }
  }

  // Extract story points (common custom fields)
  let estimate: number | undefined;
  if (fields.story_points !== undefined) {
    estimate = fields.story_points;
  } else {
    // Try common custom field IDs for story points
    for (const key of Object.keys(fields)) {
      if (key.startsWith("customfield_") && typeof fields[key] === "number") {
        estimate = fields[key];
        break;
      }
    }
  }

  return {
    externalId: issueKey,
    provider: "jira",
    title: fields.summary || "",
    description,
    acceptanceCriteria,
    labels: (fields.labels || []) as string[],
    estimate,
    status: fields.status?.name || "Unknown",
    priority: fields.priority?.name,
    url: `https://${config.domain}/browse/${issueKey}`,
    rawJson: JSON.stringify(data),
  };
}
