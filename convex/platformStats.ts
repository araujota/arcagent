import { query, internalMutation } from "./_generated/server";

type ClaimRecord = {
  bountyId: unknown;
  agentId: unknown;
  claimedAt?: number;
};

type PassedVerificationRecord = {
  bountyId: unknown;
  submissionId: unknown;
  completedAt?: number;
};

type BountyRecord = {
  _id: unknown;
  _creationTime: number;
  status: string;
  repositoryUrl?: string;
  isTestBounty?: boolean;
};

type SubmissionRecord = {
  _id: unknown;
  agentId: unknown;
};

type UserRecord = {
  _id: unknown;
};

type RepoRecord = {
  repositoryUrl: string;
};

function computeLatestClaimByBountyAgent(
  claims: ClaimRecord[],
  nonTestBountyIds: Set<string>,
): Map<string, number> {
  const latestClaimByBountyAgent = new Map<string, number>();
  for (const claim of claims) {
    if (!nonTestBountyIds.has(String(claim.bountyId))) continue;
    const key = `${String(claim.bountyId)}:${String(claim.agentId)}`;
    const existing = latestClaimByBountyAgent.get(key) ?? 0;
    const claimedAt = claim.claimedAt ?? 0;
    if (claimedAt > existing) {
      latestClaimByBountyAgent.set(key, claimedAt);
    }
  }
  return latestClaimByBountyAgent;
}

function computeAvgTimeToClaimMs(
  claims: ClaimRecord[],
  nonTestBountyIds: Set<string>,
  bountyById: Map<string, BountyRecord>,
): number {
  let totalClaimDelta = 0;
  let claimCount = 0;
  for (const claim of claims) {
    if (!claim.claimedAt || !nonTestBountyIds.has(String(claim.bountyId))) continue;
    const bounty = bountyById.get(String(claim.bountyId));
    if (!bounty) continue;
    totalClaimDelta += claim.claimedAt - bounty._creationTime;
    claimCount++;
  }
  return claimCount > 0 ? totalClaimDelta / claimCount : 0;
}

function computeAvgTimeToSolveMs(
  passedVerifications: PassedVerificationRecord[],
  nonTestBountyIds: Set<string>,
  submissionById: Map<string, SubmissionRecord>,
  latestClaimByBountyAgent: Map<string, number>,
): number {
  let totalSolveDelta = 0;
  let solveCount = 0;
  for (const verification of passedVerifications) {
    if (!verification.completedAt || !nonTestBountyIds.has(String(verification.bountyId))) continue;
    const submission = submissionById.get(String(verification.submissionId));
    if (!submission) continue;
    const claimKey = `${String(verification.bountyId)}:${String(submission.agentId)}`;
    const latestClaimedAt = latestClaimByBountyAgent.get(claimKey);
    if (!latestClaimedAt) continue;
    totalSolveDelta += verification.completedAt - latestClaimedAt;
    solveCount++;
  }
  return solveCount > 0 ? totalSolveDelta / solveCount : 0;
}

function computeTotalRepos(
  savedRepos: RepoRecord[],
  repoConnections: RepoRecord[],
  bounties: BountyRecord[],
): number {
  const repoUrls = new Set<string>();
  for (const repo of savedRepos) repoUrls.add(repo.repositoryUrl);
  for (const repoConnection of repoConnections) repoUrls.add(repoConnection.repositoryUrl);
  for (const bounty of bounties) {
    if (bounty.repositoryUrl) repoUrls.add(bounty.repositoryUrl);
  }
  return repoUrls.size;
}

export const recompute = internalMutation({
  args: {},
  handler: async (ctx) => {
    const [allClaims, passedVerifications, allBounties, allSubmissions, allUsers, allSavedRepos, allRepoConnections] =
      await Promise.all([
        ctx.db.query("bountyClaims").collect(),
        ctx.db
          .query("verifications")
          .withIndex("by_status", (q) => q.eq("status", "passed"))
          .collect(),
        ctx.db.query("bounties").collect(),
        ctx.db.query("submissions").collect(),
        ctx.db.query("users").collect(),
        ctx.db.query("savedRepos").collect(),
        ctx.db.query("repoConnections").collect(),
      ]);

    const nonTestBounties = allBounties.filter((b) => !b.isTestBounty) as BountyRecord[];
    const nonTestBountyIds = new Set(nonTestBounties.map((b) => String(b._id)));
    const bountyById = new Map(nonTestBounties.map((b) => [String(b._id), b] as const));
    const submissionById = new Map(
      (allSubmissions as SubmissionRecord[]).map((submission) => [String(submission._id), submission] as const),
    );
    const latestClaimByBountyAgent = computeLatestClaimByBountyAgent(
      allClaims as ClaimRecord[],
      nonTestBountyIds,
    );
    const avgTimeToClaimMs = computeAvgTimeToClaimMs(
      allClaims as ClaimRecord[],
      nonTestBountyIds,
      bountyById,
    );
    const avgTimeToSolveMs = computeAvgTimeToSolveMs(
      passedVerifications as PassedVerificationRecord[],
      nonTestBountyIds,
      submissionById,
      latestClaimByBountyAgent,
    );

    // --- Total bounties processed (completed) ---
    const totalBountiesProcessed = nonTestBounties.filter(
      (b) => b.status === "completed"
    ).length;

    // --- Total users (deduped by stable user ID, independent of bounty type) ---
    const totalUsers = new Set((allUsers as UserRecord[]).map((u) => String(u._id))).size;
    const totalRepos = computeTotalRepos(
      allSavedRepos as RepoRecord[],
      allRepoConnections as RepoRecord[],
      allBounties as BountyRecord[],
    );

    // --- Upsert singleton ---
    const existing = await ctx.db.query("platformStats").first();
    const stats = {
      avgTimeToClaimMs,
      avgTimeToSolveMs,
      totalBountiesProcessed,
      totalUsers,
      totalRepos,
      computedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, stats);
    } else {
      await ctx.db.insert("platformStats", stats);
    }
  },
});

export const get = query({
  args: {},
  handler: async (ctx) => {
    const stats = await ctx.db.query("platformStats").first();
    return (
      stats ?? {
        avgTimeToClaimMs: 0,
        avgTimeToSolveMs: 0,
        totalBountiesProcessed: 0,
        totalUsers: 0,
        totalRepos: 0,
        computedAt: 0,
      }
    );
  },
});
