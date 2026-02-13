import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { generateApiKey } from "../lib/crypto";
import { registerTool } from "../lib/toolHelper";
import { randomUUID } from "crypto";

export function registerRegisterAccount(server: McpServer): void {
  registerTool(
    server,
    "register_account",
    "Create a new arcagent account and get an API key. No authentication required. " +
      "Use this if you don't have an account yet. Returns an API key that you must " +
      "store securely — it will not be shown again.",
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

      try {
        const { plaintext, hash, prefix } = generateApiKey();
        const clerkId = `mcp_agent_${randomUUID()}`;

        const result = await callConvex<{ userId: string }>(
          "/api/mcp/agents/create",
          {
            name: args.name,
            email: args.email,
            clerkId,
            keyHash: hash,
            keyPrefix: prefix,
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
                  ARCAGENT_API_KEY: plaintext,
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
                `**API Key:** \`${plaintext}\``,
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
                `\`Authorization: Bearer ${plaintext}\``,
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
