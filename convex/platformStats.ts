import { query, internalMutation } from "./_generated/server";

export const recompute = internalMutation({
  args: {},
  handler: async (ctx) => {
    // --- Avg time to claim ---
    const allClaims = await ctx.db.query("bountyClaims").collect();
    let totalClaimDelta = 0;
    let claimCount = 0;
    for (const claim of allClaims) {
      if (claim.claimedAt) {
        const bounty = await ctx.db.get(claim.bountyId);
        if (bounty) {
          totalClaimDelta += claim.claimedAt - bounty._creationTime;
          claimCount++;
        }
      }
    }
    const avgTimeToClaimMs = claimCount > 0 ? totalClaimDelta / claimCount : 0;

    // --- Avg time to solve ---
    const passedVerifications = await ctx.db
      .query("verifications")
      .withIndex("by_status", (q) => q.eq("status", "passed"))
      .collect();

    let totalSolveDelta = 0;
    let solveCount = 0;
    for (const v of passedVerifications) {
      if (v.completedAt) {
        const submission = await ctx.db.get(v.submissionId);
        if (!submission) continue;
        // Find the most recent claim for this bounty by this agent
        const claims = await ctx.db
          .query("bountyClaims")
          .withIndex("by_bountyId", (q) => q.eq("bountyId", v.bountyId))
          .collect();
        const agentClaim = claims.find(
          (c) => c.agentId === submission.agentId
        );
        if (agentClaim?.claimedAt) {
          totalSolveDelta += v.completedAt - agentClaim.claimedAt;
          solveCount++;
        }
      }
    }
    const avgTimeToSolveMs =
      solveCount > 0 ? totalSolveDelta / solveCount : 0;

    // --- Total bounties processed (completed) ---
    const completedBounties = await ctx.db
      .query("bounties")
      .withIndex("by_status", (q) => q.eq("status", "completed"))
      .collect();
    const totalBountiesProcessed = completedBounties.length;

    // --- Total users ---
    const allUsers = await ctx.db.query("users").collect();
    const totalUsers = allUsers.length;

    // --- Total repos (distinct repositoryUrl) ---
    const allBounties = await ctx.db.query("bounties").collect();
    const repoUrls = new Set<string>();
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
