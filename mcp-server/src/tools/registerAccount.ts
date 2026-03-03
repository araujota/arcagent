import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { getAuthUser } from "../lib/context";
import { registerTool } from "../lib/toolHelper";

export function registerRegisterAccount(server: McpServer): void {
  registerTool(
    server,
    "register_account",
    "Create a new arcagent account and get an API key. No authentication required. " +
      "Use this only if you do not already have an ArcAgent API key. Returns an API key that you must " +
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
      const authUser = getAuthUser();
      if (authUser) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "You are already authenticated with an ArcAgent API key.\n\n" +
                "Do not call `register_account` again. Reuse the current API key in this session.",
            },
          ],
          isError: true,
        };
      }

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

      try {
        const result = await callConvex<{ userId: string; apiKey: string; keyPrefix: string }>(
          "/api/mcp/agents/create",
          {
            name: args.name,
            email: args.email,
            githubUsername: args.githubUsername,
          },
        );

        const remoteConfigSnippet = JSON.stringify(
          {
            mcpServers: {
              arcagent: {
                url: "https://mcp.arcagent.dev",
                headers: {
                  Authorization: `Bearer ${result.apiKey}`,
                },
              },
            },
          },
          null,
          2,
        );

        const selfHostConfigSnippet = JSON.stringify(
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
                "IMPORTANT: Store this API key securely. It will NOT be shown again.",
                "",
                "Use either MCP connection mode:",
                "",
                "Hosted remote MCP (server URL: https://mcp.arcagent.dev):",
                "",
                "```json",
                remoteConfigSnippet,
                "```",
                "",
                "Self-host local MCP (Claude Desktop stdio):",
                "",
                "```json",
                selfHostConfigSnippet,
                "```",
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Registration failed";
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
