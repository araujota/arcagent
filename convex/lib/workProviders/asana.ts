import { WorkItem, WorkProviderConfig } from "./types";
import { htmlToMarkdown } from "../htmlToMarkdown";

type AsanaTaskField = {
  name?: string;
  number_value?: number | null;
};

function ensureAsanaSuccess(response: Response, taskGid: string): void {
  if (response.ok) return;
  if (response.status === 404) throw new Error(`Task not found: ${taskGid}`);
  if (response.status === 401) throw new Error("Invalid Asana token");
  throw new Error(`Asana API error: ${response.status} ${response.statusText}`);
}

function extractAsanaDescription(task: Record<string, any>): string {
  if (task.html_notes) {
    return htmlToMarkdown(task.html_notes);
  }
  return task.notes ?? "";
}

function extractAsanaEstimate(fields: AsanaTaskField[] | undefined): number | undefined {
  if (!fields) return undefined;
  for (const field of fields) {
    const name = (field.name ?? "").toLowerCase();
    const isEstimateField = name.includes("story points") || name.includes("estimate") || name.includes("points");
    if (!isEstimateField) continue;
    if (field.number_value !== null && field.number_value !== undefined) {
      return field.number_value;
    }
  }
  return undefined;
}

/**
 * Fetch an Asana task by GID (numeric ID).
 * Auth: Bearer token (PAT).
 * Description format: HTML (html_notes) → converted to Markdown; fallback to plain text (notes).
 */
export async function fetchAsanaTask(
  config: WorkProviderConfig,
  taskGid: string
): Promise<WorkItem> {
  const fields = "name,notes,html_notes,tags,tags.name,custom_fields,custom_fields.name,custom_fields.number_value,custom_fields.display_value,permalink_url,assignee_status";

  const response = await fetch(
    `https://app.asana.com/api/1.0/tasks/${encodeURIComponent(taskGid)}?opt_fields=${fields}`,
    {
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        Accept: "application/json",
      },
    }
  );

  ensureAsanaSuccess(response, taskGid);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await response.json() as Record<string, any>;
  const task = result.data;

  const description = extractAsanaDescription(task);

  // Extract labels from tags
  const labels = (task.tags || []).map((t: { name: string }) => t.name);

  // Extract story points from custom fields
  const estimate = extractAsanaEstimate(task.custom_fields as AsanaTaskField[] | undefined);

  return {
    externalId: taskGid,
    provider: "asana",
    title: task.name || "",
    description,
    labels,
    estimate,
    status: task.assignee_status || "Unknown",
    url: task.permalink_url || `https://app.asana.com/0/0/${taskGid}`,
    rawJson: JSON.stringify(task),
  };
}
