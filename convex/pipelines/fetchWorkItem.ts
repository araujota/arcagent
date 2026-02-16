import { action } from "../_generated/server";
import { v } from "convex/values";
import { fetchWorkItem } from "../lib/workProviders/fetchWorkItem";
import type { WorkProviderConfig } from "../lib/workProviders/types";

/**
 * Fetch a work item from a PM tool using a stored connection.
 * The raw token is passed directly since we can't reverse the hash.
 * In production, this would use encrypted token storage; for now, token
 * is provided by the frontend which holds it in memory during the import flow.
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
    apiToken: v.string(),
  },
  handler: async (_ctx, args) => {
    const config: WorkProviderConfig = {
      provider: args.provider,
      domain: args.domain,
      email: args.email,
      apiToken: args.apiToken,
    };

    const workItem = await fetchWorkItem(args.provider, config, args.issueKey);

    // Strip rawJson to avoid sending massive payloads to the frontend
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { rawJson: _raw, ...safeItem } = workItem;

    return safeItem;
  },
});
