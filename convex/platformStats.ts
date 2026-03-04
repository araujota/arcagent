import { query, internalMutation } from "./_generated/server";

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

    const nonTestBounties = allBounties.filter((b) => !b.isTestBounty);
    const nonTestBountyIds = new Set(nonTestBounties.map((b) => String(b._id)));
    const bountyById = new Map(nonTestBounties.map((b) => [String(b._id), b]));
    const submissionById = new Map(allSubmissions.map((s) => [String(s._id), s]));

    const latestClaimByBountyAgent = new Map<string, number>();
    for (const claim of allClaims) {
      if (!nonTestBountyIds.has(String(claim.bountyId))) continue;
      const key = `${String(claim.bountyId)}:${String(claim.agentId)}`;
      const existing = latestClaimByBountyAgent.get(key) ?? 0;
      const claimedAt = claim.claimedAt ?? 0;
      if (claimedAt > existing) {
        latestClaimByBountyAgent.set(key, claimedAt);
      }
    }

    // --- Avg time to claim ---
    let totalClaimDelta = 0;
    let claimCount = 0;
    for (const claim of allClaims) {
      if (!nonTestBountyIds.has(String(claim.bountyId))) continue;
      if (claim.claimedAt) {
        const bounty = bountyById.get(String(claim.bountyId));
        if (bounty) {
          totalClaimDelta += claim.claimedAt - bounty._creationTime;
          claimCount++;
        }
      }
    }
    const avgTimeToClaimMs = claimCount > 0 ? totalClaimDelta / claimCount : 0;

    // --- Avg time to solve ---
    let totalSolveDelta = 0;
    let solveCount = 0;
    for (const v of passedVerifications) {
      if (!nonTestBountyIds.has(String(v.bountyId))) continue;
      if (v.completedAt) {
        const submission = submissionById.get(String(v.submissionId));
        if (!submission) continue;
        const claimKey = `${String(v.bountyId)}:${String(submission.agentId)}`;
        const latestClaimedAt = latestClaimByBountyAgent.get(claimKey);
        if (latestClaimedAt) {
          totalSolveDelta += v.completedAt - latestClaimedAt;
          solveCount++;
        }
      }
    }
    const avgTimeToSolveMs =
      solveCount > 0 ? totalSolveDelta / solveCount : 0;

    // --- Total bounties processed (completed) ---
    const totalBountiesProcessed = nonTestBounties.filter(
      (b) => b.status === "completed"
    ).length;

    // --- Total users (deduped by stable user ID, independent of bounty type) ---
    const totalUsers = new Set(allUsers.map((u) => String(u._id))).size;

    // --- Total repos onboarded (distinct repositoryUrl from saved/connected/used repos) ---
    const repoUrls = new Set<string>();
    for (const repo of allSavedRepos) {
      repoUrls.add(repo.repositoryUrl);
    }
    for (const repoConnection of allRepoConnections) {
      repoUrls.add(repoConnection.repositoryUrl);
    }
    for (const b of allBounties) {
      if (b.repositoryUrl) {
        repoUrls.add(b.repositoryUrl);
      }
    }
    const totalRepos = repoUrls.size;

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
