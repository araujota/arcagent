import { WorkItem, WorkProviderConfig } from "./types";

/**
 * Fetch a Linear issue by identifier (e.g., "TEAM-123").
 * Auth: Bearer token (API key).
 * Linear descriptions are native Markdown — no conversion needed.
 */
export async function fetchLinearIssue(
  config: WorkProviderConfig,
  issueKey: string
): Promise<WorkItem> {
  // Linear supports lookup by identifier via filter
  const searchQuery = `
    query SearchIssue($filter: IssueFilter!) {
      issues(filter: $filter, first: 1) {
        nodes {
          identifier
          title
          description
          url
          estimate
          priority
          priorityLabel
          state {
            name
          }
          labels {
            nodes {
              name
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: config.apiToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: searchQuery,
      variables: {
        filter: {
          identifier: { eq: issueKey },
        },
      },
    }),
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error("Invalid Linear API key");
    throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await response.json() as Record<string, any>;

  if (result.errors) {
    throw new Error(`Linear GraphQL error: ${result.errors[0]?.message || "Unknown error"}`);
  }

  const issue = result.data?.issues?.nodes?.[0];
  if (!issue) throw new Error(`Issue not found: ${issueKey}`);

  const priorityLabels: Record<number, string> = {
    0: "No priority",
    1: "Urgent",
    2: "High",
    3: "Medium",
    4: "Low",
  };

  return {
    externalId: issue.identifier,
    provider: "linear",
    title: issue.title || "",
    description: issue.description || "",
    labels: (issue.labels?.nodes || []).map((l: { name: string }) => l.name),
    estimate: issue.estimate || undefined,
    status: issue.state?.name || "Unknown",
    priority: issue.priorityLabel || priorityLabels[issue.priority] || undefined,
    url: issue.url || `https://linear.app/issue/${issueKey}`,
    rawJson: JSON.stringify(issue),
  };
}
