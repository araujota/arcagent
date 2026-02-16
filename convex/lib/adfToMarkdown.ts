/**
 * Jira ADF (Atlassian Document Format) JSON → Markdown converter.
 * Handles the common node types produced by Jira's rich text editor.
 */

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  marks?: Array<{ type: string; attrs?: Record<string, string> }>;
  attrs?: Record<string, unknown>;
}

export function adfToMarkdown(adf: unknown): string {
  if (!adf || typeof adf !== "object") return "";

  const doc = adf as AdfNode;
  if (doc.type !== "doc" || !doc.content) {
    // Might be a string already
    if (typeof adf === "string") return adf;
    return "";
  }

  return doc.content.map((node) => convertNode(node)).join("\n\n");
}

function convertNode(node: AdfNode): string {
  switch (node.type) {
    case "paragraph":
      return convertInlineContent(node.content);

    case "heading": {
      const level = (node.attrs?.level as number) || 1;
      const prefix = "#".repeat(Math.min(level, 6));
      return `${prefix} ${convertInlineContent(node.content)}`;
    }

    case "bulletList":
      return (node.content || [])
        .map((item) => `- ${convertListItem(item)}`)
        .join("\n");

    case "orderedList":
      return (node.content || [])
        .map((item, i) => `${i + 1}. ${convertListItem(item)}`)
        .join("\n");

    case "listItem":
      return convertListItem(node);

    case "codeBlock": {
      const lang = (node.attrs?.language as string) || "";
      const code = convertInlineContent(node.content);
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }

    case "blockquote":
      return (node.content || [])
        .map((child) => `> ${convertNode(child)}`)
        .join("\n");

    case "rule":
      return "---";

    case "table":
      return convertTable(node);

    case "mediaSingle":
    case "media":
      return "[media]";

    default:
      // Fallback: try to extract text content
      return convertInlineContent(node.content);
  }
}

function convertListItem(node: AdfNode): string {
  if (!node.content) return "";
  return node.content.map((child) => convertNode(child)).join("\n  ");
}

function convertInlineContent(content?: AdfNode[]): string {
  if (!content) return "";
  return content.map((node) => convertInlineNode(node)).join("");
}

function convertInlineNode(node: AdfNode): string {
  if (node.type === "text") {
    let text = node.text || "";
    if (node.marks) {
      for (const mark of node.marks) {
        switch (mark.type) {
          case "strong":
            text = `**${text}**`;
            break;
          case "em":
            text = `*${text}*`;
            break;
          case "code":
            text = `\`${text}\``;
            break;
          case "strike":
            text = `~~${text}~~`;
            break;
          case "link": {
            const href = mark.attrs?.href || "";
            text = `[${text}](${href})`;
            break;
          }
        }
      }
    }
    return text;
  }

  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return `@${node.attrs?.text || "user"}`;
  if (node.type === "emoji") return (node.attrs?.shortName as string) || "";
  if (node.type === "inlineCard") return `[${(node.attrs?.url as string) || "link"}]`;

  // Nested content (e.g., paragraph inside a list item)
  return convertInlineContent(node.content);
}

function convertTable(node: AdfNode): string {
  if (!node.content) return "";

  const rows = node.content
    .filter((row) => row.type === "tableRow")
    .map((row) =>
      (row.content || [])
        .map((cell) => convertInlineContent(cell.content?.[0]?.content))
        .join(" | ")
    );

  if (rows.length === 0) return "";

  const header = rows[0];
  const separator = header
    .split(" | ")
    .map(() => "---")
    .join(" | ");

  return [header, separator, ...rows.slice(1)].map((r) => `| ${r} |`).join("\n");
}
