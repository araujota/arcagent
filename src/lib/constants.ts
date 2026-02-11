export const BOUNTY_STATUS_LABELS = {
  draft: "Draft",
  active: "Active",
  in_progress: "In Progress",
  completed: "Completed",
  disputed: "Disputed",
} as const;

export const BOUNTY_STATUS_COLORS = {
  draft: "secondary",
  active: "default",
  in_progress: "outline",
  completed: "default",
  disputed: "destructive",
} as const;

export const SUBMISSION_STATUS_LABELS = {
  pending: "Pending",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
} as const;

export const VERIFICATION_STATUS_LABELS = {
  pending: "Pending",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
} as const;

export const STEP_STATUS_LABELS = {
  pass: "Passed",
  fail: "Failed",
  skip: "Skipped",
  error: "Error",
} as const;

export const GATE_TYPE_LABELS = {
  lint: "Lint",
  typecheck: "Type Check",
  security: "Security",
  build: "Build",
  sonarqube: "SonarQube",
} as const;

export const PAYMENT_METHOD_LABELS = {
  stripe: "Stripe",
  web3: "Web3",
} as const;

export const REPO_CONNECTION_STATUS_LABELS = {
  pending: "Pending",
  fetching: "Fetching",
  parsing: "Parsing",
  indexing: "Indexing",
  ready: "Ready",
  failed: "Failed",
} as const;

export const REPO_CONNECTION_STATUS_COLORS = {
  pending: "secondary",
  fetching: "outline",
  parsing: "outline",
  indexing: "outline",
  ready: "default",
  failed: "destructive",
} as const;

export const CONVERSATION_STATUS_LABELS = {
  gathering: "Gathering",
  clarifying: "Clarifying",
  generating_bdd: "Generating BDD",
  generating_tdd: "Generating TDD",
  review: "Review",
  finalized: "Finalized",
} as const;

export const GENERATED_TEST_STATUS_LABELS = {
  draft: "Draft",
  approved: "Approved",
  published: "Published",
} as const;

export const VERIFICATION_JOB_STATUS_LABELS = {
  queued: "Queued",
  provisioning: "Provisioning VM",
  running: "Running",
  teardown: "Cleaning Up",
  completed: "Completed",
  failed: "Failed",
  timeout: "Timed Out",
} as const;

export const NAV_ITEMS = {
  common: [
    { title: "Dashboard", href: "/dashboard", icon: "LayoutDashboard" },
    { title: "Bounties", href: "/bounties", icon: "Trophy" },
  ],
  creator: [
    { title: "My Bounties", href: "/bounties?mine=true", icon: "FileText" },
    { title: "Create Bounty", href: "/bounties/new", icon: "Plus" },
  ],
  agent: [
    { title: "My Submissions", href: "/bounties?submissions=true", icon: "Send" },
  ],
  admin: [
    { title: "All Users", href: "/settings", icon: "Users" },
  ],
} as const;
