export interface AuthenticatedUser {
  userId: string;
  name: string;
  email: string;
  role: string;
  scopes: string[];
}

export interface SessionRecord {
  sessionId: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface ConvexBounty {
  _id: string;
  title: string;
  description: string;
  status: string;
  reward: number;
  rewardCurrency: string;
  tags?: string[];
  deadline?: number;
  claimDurationHours?: number;
}

export interface ConvexBountyDetails extends ConvexBounty {
  creator: { name: string } | null;
  testSuites: Array<{
    _id: string;
    title: string;
    version: number;
    gherkinContent: string;
    visibility: "public" | "hidden";
  }>;
  repoMap: {
    repoMapText: string;
    symbolTableJson: string;
    dependencyGraphJson: string;
  } | null;
  isClaimed: boolean;
  platformFeePercent?: number;
  testFramework?: string | null;
  testLanguage?: string | null;
  relevantPaths?: string[];
}

export interface ConvexClaim {
  _id: string;
  bountyId: string;
  agentId: string;
  status: string;
  claimedAt: number;
  expiresAt: number;
  releasedAt?: number;
  featureBranchName?: string;
  featureBranchRepo?: string;
}

export interface ConvexSubmission {
  _id: string;
  bountyId: string;
  agentId: string;
  repositoryUrl: string;
  commitHash: string;
  status: string;
  description?: string;
  bounty?: ConvexBounty | null;
}

export interface VerificationGate {
  gateType: string;
  tool: string;
  status: string;
  issues?: string[];
  details?: unknown;
}

export interface VerificationStep {
  scenarioName: string;
  featureName: string;
  status: string;
  executionTimeMs: number;
  output?: string;
  stepNumber: number;
}

export interface AgentVerificationStep extends VerificationStep {
  visibility: "public" | "hidden";
}

export interface HiddenFailureMechanism {
  key: string;
  label: string;
  count: number;
  guidance: string;
}

export interface ValidationReceipt {
  attemptNumber: number;
  legKey: string;
  orderIndex: number;
  status: "pass" | "fail" | "error" | "warning" | "unreached" | "skipped_policy" | "skipped_policy_due_process";
  blocking: boolean;
  unreachedByLegKey?: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  summaryLine: string;
  rawBody?: string;
  sarif?: unknown;
  policy?: unknown;
  metadata?: unknown;
  normalized?: {
    tool: "sonarqube" | "snyk";
    blocking: {
      isBlocking: boolean;
      reasonCode: string;
      reasonText: string;
      threshold: string;
      comparedToBaseline: boolean;
    };
    counts: {
      critical: number;
      high: number;
      medium: number;
      low: number;
      bugs: number;
      codeSmells: number;
      complexityDelta: number;
      introducedTotal: number;
    };
    issues: Array<{
      tool: "sonarqube" | "snyk";
      category: string;
      severity: "critical" | "high" | "medium" | "low" | "info";
      isBlocking: boolean;
      file?: string;
      line?: number;
      rule?: string;
      message: string;
      suggestion?: string;
      introducedOnNewCode: boolean;
    }>;
    truncated: boolean;
  };
}

/** Agent-facing verification status — all scenarios visible with verbose output. */
export interface ConvexAgentVerification {
  _id: string;
  submissionId: string;
  bountyId: string;
  status: string;
  result?: string;
  startedAt?: number;
  completedAt?: number;
  errorLog?: string;
  gates: VerificationGate[];
  steps: AgentVerificationStep[];
  hiddenSummary?: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  hiddenFailureMechanisms?: HiddenFailureMechanism[];
  validationReceipts?: ValidationReceipt[];
  feedbackJson?: string;
  job: {
    status: string;
    currentGate?: string;
    queuedAt: number;
    startedAt?: number;
    completedAt?: number;
  } | null;
}

/** Full verification status (dashboard/internal use — includes all step details). */
export interface ConvexVerification {
  _id: string;
  submissionId: string;
  bountyId: string;
  status: string;
  result?: string;
  startedAt?: number;
  completedAt?: number;
  errorLog?: string;
  gates: VerificationGate[];
  steps: VerificationStep[];
  job: {
    status: string;
    currentGate?: string;
    queuedAt: number;
    startedAt?: number;
    completedAt?: number;
  } | null;
}
