import { WorkItem, WorkProvider, WorkProviderConfig } from "./types";
import { fetchJiraIssue } from "./jira";
import { fetchLinearIssue } from "./linear";
import { fetchAsanaTask } from "./asana";
import { fetchMondayItem } from "./monday";

/**
 * Unified dispatcher for fetching work items from any supported PM tool.
 */
export async function fetchWorkItem(
  provider: WorkProvider,
  config: WorkProviderConfig,
  issueKey: string
): Promise<WorkItem> {
  switch (provider) {
    case "jira":
      return fetchJiraIssue(config, issueKey);
    case "linear":
      return fetchLinearIssue(config, issueKey);
    case "asana":
      return fetchAsanaTask(config, issueKey);
    case "monday":
      return fetchMondayItem(config, issueKey);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
