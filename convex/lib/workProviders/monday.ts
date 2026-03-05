import { WorkItem, WorkProviderConfig } from "./types";

function buildMondayApiError(response: Response): Error {
  if (response.status === 401) return new Error("Invalid Monday.com API key");
  return new Error(`Monday.com API error: ${response.status} ${response.statusText}`);
}

type MondayExtractedFields = {
  description: string;
  status: string;
  labels: string[];
};

function parseTagLabels(text: string): string[] {
  return text.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function isLongTextType(type: string): boolean {
  return type === "long_text" || type === "long-text";
}

function isDescriptionTextColumn(type: string, title: string): boolean {
  return type === "text" && title.includes("description");
}

function isStatusType(type: string): boolean {
  return type === "status" || type === "color";
}

function isPrimaryStatusTitle(title: string): boolean {
  return title === "status" || title === "state";
}

function isTagType(type: string): boolean {
  return type === "tag" || type === "tags";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMondayFields(item: any): MondayExtractedFields {
  let description = "";
  let status = "Unknown";
  const labels: string[] = [];

  for (const col of item.column_values || []) {
    const type = col.type?.toLowerCase() || "";
    const title = (col.title || "").toLowerCase();
    const text = col.text as string | undefined;
    if (!text) continue;

    const isDescriptionColumn = isLongTextType(type) || isDescriptionTextColumn(type, title);
    if (!description && isDescriptionColumn) {
      description = text;
      continue;
    }

    if (isStatusType(type)) {
      const useAsStatus = isPrimaryStatusTitle(title);
      if (useAsStatus) status = text;
      else labels.push(text);
      continue;
    }

    if (isTagType(type)) {
      labels.push(...parseTagLabels(text));
    }
  }

  if (item.group?.title) labels.push(item.group.title);
  return { description, status, labels };
}

/**
 * Fetch a Monday.com item by numeric ID.
 * Auth: Bearer token (API key).
 * Description: Extracted from long_text or text column values.
 */
export async function fetchMondayItem(
  config: WorkProviderConfig,
  itemId: string
): Promise<WorkItem> {
  const query = `
    query GetItem($ids: [ID!]!) {
      items(ids: $ids) {
        id
        name
        state
        url
        column_values {
          id
          title
          text
          value
          type
        }
        group {
          title
        }
      }
    }
  `;

  const response = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: config.apiToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: { ids: [itemId] },
    }),
  });

  if (!response.ok) {
    throw buildMondayApiError(response);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await response.json() as Record<string, any>;

  if (result.errors) {
    throw new Error(
      `Monday.com GraphQL error: ${result.errors[0]?.message || "Unknown error"}`
    );
  }

  const item = result.data?.items?.[0];
  if (!item) throw new Error(`Item not found: ${itemId}`);
  const { description, status, labels } = extractMondayFields(item);

  const slug = config.domain || "";
  const url = item.url || (slug ? `https://${slug}.monday.com/boards` : `https://monday.com`);

  return {
    externalId: itemId,
    provider: "monday",
    title: item.name || "",
    description,
    labels: [...new Set(labels)],
    status,
    url,
    rawJson: JSON.stringify(item),
  };
}
