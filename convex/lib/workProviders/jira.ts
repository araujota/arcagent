import { WorkItem, WorkProviderConfig } from "./types";
import { adfToMarkdown } from "../adfToMarkdown";

function assertJiraConfig(config: WorkProviderConfig): void {
  if (!config.domain) throw new Error("Jira domain is required");
  if (!config.email) throw new Error("Jira email is required");
}

function buildJiraError(response: Response, issueKey: string): Error {
  if (response.status === 404) return new Error(`Issue not found: ${issueKey}`);
  if (response.status === 401) return new Error("Invalid Jira credentials");
  return new Error(`Jira API error: ${response.status} ${response.statusText}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractDescription(fields: Record<string, any>): string {
  if (!fields.description) return "";
  return typeof fields.description === "string"
    ? fields.description
    : adfToMarkdown(fields.description);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAcceptanceCriteria(fields: Record<string, any>): string | undefined {
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (!key.startsWith("customfield_") || typeof value !== "string") continue;
    if (!value.toLowerCase().includes("acceptance")) continue;
    return value;
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractEstimate(fields: Record<string, any>): number | undefined {
  if (fields.story_points !== undefined) return fields.story_points;
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (key.startsWith("customfield_") && typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

/**
 * Fetch a Jira issue by key (e.g., "PROJ-123").
 * Auth: Basic Auth (email:apiToken base64-encoded).
 */
export async function fetchJiraIssue(
  config: WorkProviderConfig,
  issueKey: string
): Promise<WorkItem> {
  assertJiraConfig(config);

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
    throw buildJiraError(response, issueKey);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await response.json() as Record<string, any>;
  const fields = data.fields;
  const description = extractDescription(fields);
  const acceptanceCriteria = extractAcceptanceCriteria(fields);
  const estimate = extractEstimate(fields);

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
