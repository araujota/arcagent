import { Doc, Id } from "../../convex/_generated/dataModel";

export type User = Doc<"users">;
export type Bounty = Doc<"bounties">;
export type TestSuite = Doc<"testSuites">;
export type Submission = Doc<"submissions">;
export type Verification = Doc<"verifications">;
export type SanityGate = Doc<"sanityGates">;
export type VerificationStep = Doc<"verificationSteps">;
export type Payment = Doc<"payments">;
export type RepoConnection = Doc<"repoConnections">;
export type RepoMap = Doc<"repoMaps">;
export type CodeChunk = Doc<"codeChunks">;
export type Conversation = Doc<"conversations">;
export type GeneratedTest = Doc<"generatedTests">;
export type VerificationJob = Doc<"verificationJobs">;

export type BountyWithCreator = Bounty & { creator: User | null };
export type SubmissionWithAgent = Submission & { agent: User | null };
export type SubmissionWithBounty = Submission & { bounty: Bounty | null };
export type PaymentWithBounty = Payment & { bounty: Bounty | null };
export type VerificationWithSubmission = Verification & {
  submission: Submission | null;
};

export type BountyStatus =
  | "draft"
  | "active"
  | "in_progress"
  | "completed"
  | "disputed"
  | "cancelled";

export type SubmissionStatus = "pending" | "running" | "passed" | "failed";
export type VerificationStatus = "pending" | "running" | "passed" | "failed";
export type StepStatus = "pass" | "fail" | "skip" | "error";
export type GateType = "lint" | "typecheck" | "security" | "build" | "sonarqube" | "snyk" | "memory";
export type GateStatus = "passed" | "failed" | "warning";
export type UserRole = "creator" | "agent" | "admin";
export type PaymentMethod = "stripe" | "web3";
export type TestVisibility = "public" | "hidden";

export type RepoConnectionStatus =
  | "pending"
  | "fetching"
  | "parsing"
  | "indexing"
  | "ready"
  | "failed";

export type ConversationStatus =
  | "gathering"
  | "clarifying"
  | "generating_bdd"
  | "generating_tdd"
  | "review"
  | "finalized";

export type GeneratedTestStatus = "draft" | "approved" | "published";

export type VerificationJobStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "teardown"
  | "completed"
  | "failed"
  | "timeout";

export type SymbolType =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "method"
  | "module"
  | "enum"
  | "constant";

export type BountyId = Id<"bounties">;
export type UserId = Id<"users">;
export type SubmissionId = Id<"submissions">;
export type VerificationId = Id<"verifications">;
export type RepoConnectionId = Id<"repoConnections">;
export type ConversationId = Id<"conversations">;
export type GeneratedTestId = Id<"generatedTests">;
