export interface WorkItem {
  externalId: string;
  provider: WorkProvider;
  title: string;
  description: string;
  acceptanceCriteria?: string;
  labels: string[];
  estimate?: number;
  status: string;
  priority?: string;
  url: string;
  rawJson: string;
}

export type WorkProvider = "jira" | "linear" | "asana" | "monday";

export interface WorkProviderConfig {
  provider: WorkProvider;
  domain?: string;
  email?: string;
  apiToken: string;
}
