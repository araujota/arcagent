import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "expire stale bounty claims",
  { minutes: 5 },
  internal.bountyClaims.expireStale,
);

export default crons;
