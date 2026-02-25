import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { findOrCreateClerkUser } from "../lib/clerk";

export function registerRegisterAccount(server: McpServer): void {
  registerTool(
    server,
    "register_account",
    "Create a new arcagent account and get an API key. No authentication required. " +
      "Use this if you don't have an account yet. Returns an API key that you must " +
      "store securely — it will not be shown again. If you already have a web account " +
      "with the same email, this will link to it.",
    {
      name: z.string().describe("Your display name"),
      email: z.string().describe("Your email address"),
      githubUsername: z
        .string()
        .optional()
        .describe("Your GitHub username (optional, used for repo access)"),
    },
    async (args: { name: string; email: string; githubUsername?: string }) => {
      // This tool intentionally does NOT require auth — it's the entry point
      // for new agents to create an account and get their first API key.

      if (!args.name || !args.email) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: name and email are required.",
            },
          ],
          isError: true,
        };
      }

      let clerkId: string | undefined;
      try {
        // Create or find existing Clerk user (unified accounts)
        const clerkResult = await findOrCreateClerkUser(
          args.name,
          args.email,
          args.githubUsername,
        );
        clerkId = clerkResult.clerkId;
        const isExisting = clerkResult.isExisting;

        const result = await callConvex<{ userId: string; apiKey: string; keyPrefix: string }>(
          "/api/mcp/agents/create",
          {
            name: args.name,
            email: args.email,
            clerkId,
            githubUsername: args.githubUsername,
          },
        );

        const configSnippet = JSON.stringify(
          {
            mcpServers: {
              arcagent: {
                command: "npx",
                args: ["-y", "arcagent-mcp"],
                env: {
                  ARCAGENT_API_KEY: result.apiKey,
                },
              },
            },
          },
          null,
          2,
        );

        const accountNote = isExisting
          ? "Linked to your existing arcagent account. You can also sign in via the web UI."
          : "New account created. You can also sign in to the web UI at any time.";

        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Account created successfully!",
                "",
                `**User ID:** ${result.userId}`,
                `**API Key:** \`${result.apiKey}\``,
                "",
                accountNote,
                "",
                "IMPORTANT: Store this API key securely. It will NOT be shown again.",
                "",
                "To use this key with Claude Desktop, add this to your `claude_desktop_config.json`:",
                "",
                "```json",
                configSnippet,
                "```",
                "",
                "For HTTP transport, set the Authorization header:",
                `\`Authorization: Bearer ${result.apiKey}\``,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Registration failed";
        const clerkNote = clerkId
          ? ` (Clerk user was created: ${clerkId}. Contact support if this persists.)`
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${message}${clerkNote}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
