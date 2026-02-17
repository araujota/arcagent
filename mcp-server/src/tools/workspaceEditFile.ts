import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

export function registerWorkspaceEditFile(server: McpServer): void {
  registerTool(
    server,
    "workspace_edit_file",
    "Perform a surgical text replacement in a file. Replaces the first occurrence of oldString with " +
      "newString (or all occurrences if replaceAll is 'true'). This is safer than rewriting the entire file " +
      "because it only touches the specific text you want to change. The oldString must match exactly " +
      "(including whitespace and indentation). Paths relative to /workspace.",
    {
      bountyId: z.string().describe("The bounty ID you have claimed"),
      path: z.string().describe("File path relative to /workspace"),
      oldString: z.string().describe("The exact text to find and replace"),
      newString: z.string().describe("The replacement text"),
      replaceAll: z
        .string()
        .optional()
        .describe("Replace all occurrences: 'true' or 'false' (default 'false')"),
    },
    async (args) => {
      // SECURITY (H4): Scope enforcement
      requireScope("workspace:write");
      // SECURITY (C1): Identity from auth context
      const user = requireAuthUser();

      const ws = await getWorkspaceForAgent(user.userId, args.bountyId);
      if (!ws.found || ws.status !== "ready") {
        return {
          content: [
            {
              type: "text" as const,
              text: ws.found
                ? `Workspace is not ready (status: ${ws.status}).`
                : "No workspace found. Claim the bounty first.",
            },
          ],
          isError: true,
        };
      }

      // SECURITY (W3): Defense-in-depth path validation at MCP layer
      const normalizedPath = args.path.replace(/\\/g, "/");
      if (normalizedPath.includes("..") && !normalizedPath.startsWith("/workspace/")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Path traversal not allowed. Paths must resolve within /workspace/.",
            },
          ],
          isError: true,
        };
      }

      if (args.oldString === args.newString) {
        return {
          content: [
            {
              type: "text" as const,
              text: "oldString and newString are identical. No changes needed.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await callWorker<{
          path: string;
          replacements: number;
        }>(ws.workerHost, "/api/workspace/edit-file", {
          workspaceId: ws.workspaceId,
          path: args.path,
          oldString: args.oldString,
          newString: args.newString,
          replaceAll: args.replaceAll === "true",
        });

        return {
          content: [
            {
              type: "text" as const,
              text:
                result.replacements === 0
                  ? `No matches found for the specified text in \`${result.path}\`. Verify the oldString matches exactly (including whitespace).`
                  : `Replaced ${result.replacements} occurrence${result.replacements > 1 ? "s" : ""} in \`${result.path}\``,
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "File edit failed";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
