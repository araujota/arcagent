import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

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

export default crons;
