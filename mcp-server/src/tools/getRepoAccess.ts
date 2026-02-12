import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateForkAccessToken } from "../github/forkManager";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

export function registerGetRepoAccess(server: McpServer): void {
  registerTool(
    server,
    "get_repo_access",
    "Refresh the fork access token when the old one expires. Returns a new push token for your fork.",
    {
      forkFullName: z.string().describe("The full name of the fork (e.g. arcagent-mirrors/repo-abc123-def456)"),
      expiresInHours: z.string().optional().describe("Hours until the new token expires (default: 4)"),
    },
    async (args: { forkFullName: string; expiresInHours?: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:claim");
      try {
        const hours = args.expiresInHours ? parseInt(args.expiresInHours, 10) : 4;
        const expiresAt = Date.now() + hours * 60 * 60 * 1000;

        const access = await generateForkAccessToken(args.forkFullName, expiresAt);

        return {
          content: [
            {
              type: "text" as const,
              text: `# Fresh Repository Access\n\n**Fork URL:** ${access.forkUrl}\n**Clone:** \`${access.cloneCommand}\`\n**Expires:** ${new Date(access.tokenExpiresAt).toISOString()}`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to generate access token";
        return {
          content: [{ type: "text" as const, text: `Failed to refresh access token: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
