import { action } from "../_generated/server";
import { v } from "convex/values";
import { fetchWorkItem } from "../lib/workProviders/fetchWorkItem";
import type { WorkProviderConfig } from "../lib/workProviders/types";
import { internal } from "../_generated/api";

function splitAcceptanceCriteria(input?: string): string[] {
  if (!input) return [];
  return input
    .split(/\n+/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean);
}

/**
 * Fetch a work item from a PM tool.
 * Supports either ephemeral token input (apiToken) or reusable encrypted
 * PM connections (pmConnectionId).
 */
export const fetchWorkItemAction = action({
  args: {
    provider: v.union(
      v.literal("jira"),
      v.literal("linear"),
      v.literal("asana"),
      v.literal("monday")
    ),
    issueKey: v.string(),
    domain: v.optional(v.string()),
    email: v.optional(v.string()),
    apiToken: v.optional(v.string()),
    pmConnectionId: v.optional(v.id("pmConnections")),
  },
  handler: async (ctx, args) => {
    let apiToken = args.apiToken;
    let domain = args.domain;
    let email = args.email;

    if (!apiToken && args.pmConnectionId) {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) {
        throw new Error("Authentication required");
      }
      const user = await ctx.runQuery(internal.users.getByClerkIdInternal, {
        clerkId: identity.subject,
      });
      if (!user) {
        throw new Error("Authenticated user not found");
      }
      const connection = await ctx.runQuery(internal.pmConnections.getDecryptedByIdInternal, {
        connectionId: args.pmConnectionId,
      });

      if (!connection) {
        throw new Error("PM connection not found");
      }
      if (connection.userId !== user._id) {
        throw new Error("Unauthorized PM connection access");
      }
      if (connection.provider !== args.provider) {
        throw new Error("PM connection provider does not match requested provider");
      }

      apiToken = connection.apiToken;
      domain = domain ?? connection.domain;
      email = email ?? connection.email;
    }

    if (!apiToken) {
      throw new Error("apiToken is required unless pmConnectionId is provided");
    }

    const config: WorkProviderConfig = {
      provider: args.provider,
      domain,
      email,
      apiToken,
    };

    const workItem = await fetchWorkItem(args.provider, config, args.issueKey);

    // Strip rawJson to avoid sending massive payloads to the frontend
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { rawJson: _raw, ...safeItem } = workItem;

    const acceptanceCriteriaList = splitAcceptanceCriteria(safeItem.acceptanceCriteria);

    return {
      ...safeItem,
      // Normalized ingestion contract
      descriptionMarkdown: safeItem.description,
      acceptanceCriteriaList,
      links: safeItem.url ? [safeItem.url] : [],
      externalUpdatedAt: undefined,
      // Backward-compat aliases used by current UI and MCP rendering
      description: safeItem.description,
      acceptanceCriteriaText: safeItem.acceptanceCriteria,
    };
  },
});
