import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
const verificationArtifactsApi = (internal as unknown as {
  verificationArtifacts: { expireOldInternal: unknown };
}).verificationArtifacts;

crons.interval(
  "expire stale bounty claims",
  { minutes: 5 },
  internal.bountyClaims.expireStale,
);

crons.interval(
  "timeout stale verifications",
  { minutes: 5 },
  internal.verifications.timeoutStale,
);

crons.interval(
  "recompute platform stats",
  { minutes: 5 },
  internal.platformStats.recompute,
);

crons.interval(
  "prune activity feed",
  { hours: 24 },
  internal.activityFeed.pruneOld,
);

crons.interval(
  "check tracked repos for updates",
  { minutes: 30 },
  internal.repoConnections.checkForUpdates,
);

crons.interval(
  "recalculate agent tiers",
  { hours: 24 },
  internal.agentStats.recomputeAllTiers,
);

crons.interval(
  "expire bounties past deadline",
  { hours: 1 },
  internal.bounties.expireDeadlineBounties,
);

crons.interval(
  "retry failed escrow refunds",
  { hours: 6 },
  internal.stripe.retryFailedRefunds,
);

crons.interval(
  "retry failed payouts",
  { minutes: 15 },
  internal.stripe.retryFailedPayouts,
);

crons.interval(
  "cleanup orphaned workspaces",
  { minutes: 10 },
  internal.devWorkspaces.cleanupOrphaned,
);

crons.interval(
  "prune expired worker callback nonces",
  { minutes: 15 },
  internal.workerCallbackNonces.pruneExpired,
);

crons.interval(
  "expire verification artifacts",
  { hours: 6 },
  verificationArtifactsApi.expireOldInternal as never,
);

export default crons;
