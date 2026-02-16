import { WorkItem, WorkProviderConfig } from "./types";

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
    if (response.status === 401) throw new Error("Invalid Monday.com API key");
    throw new Error(`Monday.com API error: ${response.status} ${response.statusText}`);
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

  // Extract description from long_text or text columns
  let description = "";
  let status = "Unknown";
  const labels: string[] = [];

  for (const col of item.column_values || []) {
    const type = col.type?.toLowerCase() || "";
    const title = (col.title || "").toLowerCase();

    // Description: prefer long_text columns
    if (
      (type === "long_text" || type === "long-text") &&
      col.text &&
      !description
    ) {
      description = col.text;
    } else if (type === "text" && col.text && !description && title.includes("description")) {
      description = col.text;
    }

    // Status column
    if (type === "status" || type === "color") {
      if (col.text) {
        if (title === "status" || title === "state") {
          status = col.text;
        } else {
          labels.push(col.text);
        }
      }
    }

    // Tags/label columns
    if (type === "tag" || type === "tags") {
      if (col.text) {
        labels.push(...col.text.split(",").map((t: string) => t.trim()));
      }
    }
  }

  // Fallback: if we found a group, use it as context
  if (item.group?.title) {
    labels.push(item.group.title);
  }

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
