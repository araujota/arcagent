# ArcAgent: Task-Market, Tiering, and Pricing Evaluation

Date: March 8, 2026

## Executive Summary

Three conclusions fall out of the product, the codebase, and current substitute pricing.

1. ArcAgent should not compete for all software work. It should focus on bounded backlog tasks that are clearly scoped, mechanically verifiable, and valuable enough to justify per-ticket payment, but not important enough to deserve a staff engineer's active attention.
2. The current tiering system contains several good ingredients, but it does not yet cleanly measure what paying clients and agent operators care about most. It also has a few structural issues that can produce misleading rank signals.
3. ArcAgent will not win on raw compute price. GitHub Copilot background, Cursor, Claude Code, and direct API usage are all cheap on a per-task basis. ArcAgent only wins when its market and verification layer reduce human management cost and create external execution capacity.

The practical implication is straightforward:

- Web copy should narrow the task category aggressively.
- Pricing should assume ArcAgent is selling outsourced execution, not cheap inference.
- Tiering should shift from a generic composite score to a buyer-trust score plus specialist routing signals.

## 1. The Task Market ArcAgent Should Target

### The ideal ArcAgent task

The best ArcAgent task has six properties:

- the failure or target behavior is observable
- the acceptance criteria can be frozen before work starts
- success can be tested with CI, fixtures, or hidden checks
- the task is annoying enough to defer internally
- the business risk is limited if the scope is honored
- the buyer would rather inspect an outcome than manage a session

This is the market:

"important enough to pay for, not important enough to personally shepherd."

### Real-world task types that fit

| Task type | Concrete example | Why it fits ArcAgent | Suggested bounty band |
| --- | --- | --- | --- |
| Regression bug fix | "This API returns `500` when `customer_id` is missing; add a regression test and fix the handler." | Clear repro, narrow diff, obvious success condition. | $125-$350 |
| Dependency or framework upgrade | "Upgrade Next.js 15.2 to 15.3 for the dashboard package and resolve build/test breakage." | Mechanical, testable, often low-status work internally. | $150-$500 |
| Lint/type debt cleanup | "Bring `packages/billing-ui` to zero ESLint and TypeScript errors without behavior changes." | Highly verifiable, tedious, easy to constrain. | $100-$250 |
| Flaky test stabilization | "Playwright test `checkout coupon applies on refresh` flakes on CI; stabilize it and prove reliability." | Existing failure signal, measurable success, limited blast radius. | $125-$300 |
| Test backfill for known behavior | "Add integration tests for webhook retry logic and ensure current behavior is preserved." | Strong fit for hidden/public acceptance criteria. | $100-$300 |
| Small integration glue work | "Wire Slack alert delivery into the existing notification service with fixtures and contract tests." | Concrete interface boundaries, easy to specify. | $200-$600 |
| Codemod / migration | "Replace deprecated internal logger calls in `services/payments/**` and keep tests green." | Bounded search surface, repeatable, well suited to agents. | $200-$800 |
| CI or build repair | "Fix the Docker build after pnpm workspace changes; must pass the current pipeline." | Mechanical, easy to verify, often not worth senior attention. | $100-$300 |
| Small internal tooling | "Add a bulk archive action to the admin panel behind the existing feature flag with tests." | Useful but rarely priority-one for core engineers. | $250-$750 |
| SDK/client or schema drift repair | "Regenerate the API client for v3, patch the type mismatches, and update affected tests." | Deterministic and measurable, but operationally annoying. | $150-$500 |

### Markets ArcAgent should avoid

These are bad fits and should be explicitly excluded in positioning:

| Task market to avoid | Why it is bad for ArcAgent |
| --- | --- |
| Greenfield architecture | The value is in exploration and judgment, not verifiable execution. |
| Core product design work | Requirements move during implementation; acceptance cannot be frozen cleanly. |
| Mission-critical auth, billing, or incident response without mature test harnesses | Too much downside if verification is incomplete. |
| Ambiguous "build this feature" tickets | These collapse back into interactive management. |
| Work requiring heavy tacit company context | External agents cannot infer unwritten business logic reliably. |
| Major UX or design-heavy front-end work | Acceptance becomes subjective and review burden rises sharply. |
| Multi-team changes with coordination overhead | The bottleneck is organizational, not implementation. |

### Recommended market wedge

ArcAgent should describe itself as best for:

- bugs with reproducible failures
- upgrades and migrations with visible breakage
- CI, lint, and type repair
- test backfill and flaky-test cleanup
- small integrations and internal tooling
- backlog chores that are bounded, verifiable, and low-drama

It should explicitly say it is not for:

- architecture
- open-ended product features
- design-heavy work
- poorly tested critical systems

### Web copy recommendation

Homepage and product copy should stop implying general-purpose software execution and instead say something close to:

"ArcAgent is for bounded engineering backlog work: bug fixes, upgrades, CI repair, test backfill, small integrations, and internal tooling. If a task is clearly scoped and testable but not worth an engineer's active attention, it belongs here."

And just as importantly:

"ArcAgent is not for architecture, open-ended feature design, or critical systems without strong tests."

That level of specificity will help both sides of the market qualify themselves correctly.

## 2. Price Logic and Substitute Economics

## The first principle

ArcAgent cannot win on raw model cost.

The substitutes are too cheap:

- GitHub Copilot Pro is $10 per user per month, Business is $19, and Enterprise is $39.[1]
- GitHub charges $0.04 for each additional premium request beyond the included allowance, and Copilot coding agent uses one premium request per session, multiplied by the model multiplier.[2][3]
- GitHub Actions Linux x64 runtime is $0.008 per minute outside included minutes.[4]
- Cursor is priced at $20/month for Pro, $60/month for Pro+, and $200/month for Ultra.[5]
- Claude Code's own docs say typical Sonnet 4 usage lands around $100-$200 per developer per month.[6]
- Devin Team starts at $500/month and includes 250 ACUs.[7]
- Direct API costs for coding models are also low on a per-task basis: OpenAI lists GPT-5 codex at $1.25 / 1M input tokens and $10 / 1M output tokens; Anthropic lists Claude Sonnet 4 at $3 / 1M input and $15 / 1M output.[8][9]

That means ArcAgent is not a cheaper way to "run an agent." It is a different product.

### What the real comparison should be

The economic comparison is:

ArcAgent bounty cost

versus

internal engineer attention cost
+ internal tool cost
+ queueing cost
+ the opportunity cost of not doing higher-value work

The model bill is usually the smallest number in the equation.

### Benchmarks for substitute cost

#### GitHub Copilot background / coding agent

If a team already pays for Copilot:

- the fixed seat cost is $10-$39 per user per month depending on plan[1]
- included premium requests cover some amount of background-agent usage[1][2]
- overage is $0.04 per premium request[2]
- a typical 10-minute Linux runner session is about $0.08 outside included Actions minutes[4]

So the raw platform cost of one Copilot coding-agent attempt is often between effectively free and roughly $0.12-$0.50, depending on seat amortization, included allotments, and whether premium overages or Actions overages apply.

That is extremely cheap.

#### "Open another tab" with your own agent

Using API-priced models is also cheap enough that it should not be the main competitive frame.

Illustrative model-only cost estimates:

| Task size assumption | Example token budget | GPT-5 codex model cost | Claude Sonnet 4 model cost |
| --- | --- | --- | --- |
| Small task | 200k input, 40k output | ~$0.65 | ~$1.20 |
| Medium task | 1.0M input, 200k output | ~$3.25 | ~$6.00 |
| Large task | 3.0M input, 600k output | ~$9.75 | ~$18.00 |

These are model costs only. They exclude human management time, retries, and validation, which is where the real spend sits.[8][9]

### Where ArcAgent can be rational

ArcAgent becomes rational when it removes enough human attention to outweigh the bounty price.

The relevant equation is:

`ArcAgent is worth it if bounty price <= (manager or engineer time saved * loaded hourly cost) + parallelism value + backlog/latency value - substitute compute cost`

Using U.S. Bureau of Labor Statistics data, the median software developer wage is $132,270/year in the U.S., or roughly $64/hour before overhead.[10] Fully loaded cost for an experienced engineer is often materially higher than that once benefits, tax, management overhead, and context switching are included.

So if using Copilot, Cursor, Claude Code, or a direct agent still requires:

- 10-15 minutes to spec the task
- 10-20 minutes to inspect, fix, and merge the output
- 5-10 minutes of follow-up steering or cleanup

the internal labor component can easily dominate the tool cost.

That is why ArcAgent should anchor pricing around attention saved, not tokens spent.

### Recommended bounty-price logic

The right pricing story is not parity with model inference. It is parity with "tool cost plus active human handling."

Recommended framing:

- Below $75: usually a bad market for ArcAgent. These tasks are too cheap to handle internally with Copilot or another tab unless review drops near zero.
- $100-$250: viable for small but annoying tickets if ArcAgent reliably returns merge-ready work and keeps review under about 10 minutes.
- $150-$600: the likely sweet spot. This is where bounded backlog work is painful enough to outsource but still structured enough to verify.
- $600-$1,000: viable for bundled migrations, integration tasks, or admin tooling where internal queueing cost is high.
- Above $1,000: should be treated carefully. The more expensive the task, the more likely it drifts into architecture, ambiguity, or contractor-style work.

This also means the current minimums are probably directionally right for launch, but messaging should be explicit:

- ArcAgent is a premium on top of cheap internal agent usage because it is selling outsourced execution and trust.
- The buyer should expect to pay more than raw tool cost and less than manually managing the same work through internal engineering bandwidth.

## 3. Evaluation of the Current Tiering Algorithm

## What buyers care about

Paying clients care about:

- probability the work will pass verification quickly
- probability the result is close to merge-ready
- amount of review and cleanup required
- speed and predictability
- fit for the specific task type, language, and repo shape
- low risk of churn, retries, and surprises

## What agent operators care about

Agent operators care about:

- a fair and legible path to rank up
- protection from arbitrary buyer bias
- reward for specialization, not just generic volume
- recency, so improvement actually shows up
- meaningful differentiation for hard tasks
- signals that correlate with future earning access

## What the current code does well

The current implementation is materially more thoughtful than the public copy suggests.

Strengths in the code:

- It uses five inputs, not three: creator rating, time to resolution, first-attempt pass, gate quality, and completion rate (`convex/lib/tierCalculation.ts`, `convex/agentStats.ts`).
- It uses time decay, which helps recent performance matter more.
- It reward-weights ratings using bounty value, which prevents tiny jobs from having the same influence as meaningful jobs.
- It uses same-creator throttling and a single-creator concentration cap, which is a good anti-sybil and anti-farming measure.
- It requires minimum completions and unique raters before ranking.

Those are good foundations.

## Where the current algorithm misses buyer and operator value

### Finding 1: public positioning does not match the actual algorithm

Marketing and FAQ copy say the composite score is based on verification pass rate, completed bounty count, and average creator rating, but the code actually uses a weighted mix of creator rating, time to resolution, first-attempt pass, gate quality, and completion rate.[11][12][13]

Why this matters:

- buyers do not know what the badge means
- operators do not know what behavior to optimize for
- the platform looks less rigorous than it actually is

### Finding 2: the tier system is relative, not absolute

Tiers are assigned by percentile rank among qualified agents, not by absolute quality thresholds (`assignTierByPercentile`). In small pools, one agent can become S-tier simply by being the best of one or two qualified participants.[11]

Why this matters:

- an "S" in a tiny market does not mean elite in absolute terms
- buyers may over-trust the badge
- operators may get rank swings because the pool changed, not because they improved or regressed

This is fine for leaderboard cosmetics; it is weak for purchase trust.

### Finding 3: one of the highest-value buyer metrics is diluted away

The system collects `mergedWithoutChanges` as an explicit rating dimension, which is close to what buyers care about most, but then averages it equally with code quality, speed, communication, and test coverage into a single creator rating contribution.[14][15]

Why this matters:

- merge-readiness should be a first-class signal
- communication quality should not have equal weight with merge readiness for autonomous agent ranking
- buyers care much more about rework burden than about whether the description text was polished

### Finding 4: the speed metric is partly creator-controlled

`timeToResolution` is normalized against bounty claim duration using `1 - resolutionMs / claimDurationMs` (`convex/agentStats.ts`). That means the same 2-hour solve scores differently on a 4-hour claim than on an 8-hour claim.[13]

Why this matters:

- score comparability across bounties is reduced
- creators can unintentionally or intentionally affect the score by setting claim duration
- operators are being graded partly on bounty configuration rather than pure performance

### Finding 5: first-attempt pass is only measured on completed claims

`firstAttemptPassRate` uses completed claims as the denominator. That means an agent can fail hard tickets, release or expire them, and avoid damaging first-pass performance on those tasks, while only taking the smaller completion-rate hit.[13]

Why this matters:

- buyers care about reliability across all accepted work attempts, not only the ones that end in success
- operators can look cleaner than their actual attempt quality suggests

### Finding 6: gate quality is weakly measured

`gateQualityScore` counts passed versus warning gates only on passing verifications. Failures are not directly reflected here, and warnings themselves may be unevenly informative.[13]

Why this matters:

- this is not a strong proxy for "clean code"
- an agent that takes several dirty attempts before a final pass is not fully captured by this metric

### Finding 7: low-value ratings can still help qualification

Ratings below the tier-eligible reward floor do not contribute to weighted rating quality, but creators from those ratings still count toward `uniqueRaters`, which is part of tier qualification.[13][16]

Why this matters:

- an operator can partially bootstrap qualification via lower-value or strategically arranged jobs
- the qualification barrier is not aligned tightly with economically meaningful performance

### Finding 8: the leaderboard query appears to return all stats, not only qualified ranked agents

The leaderboard query simply sorts `agentStats` by composite score and returns the top rows; it does not filter out unqualified agents. The UI copy, however, says agents need at least 5 completed bounties and 3 unique raters to appear on the leaderboard.[13][17]

Why this matters:

- the product may display a signal that contradicts its stated policy
- unranked or low-confidence agents can look more official than intended

### Finding 9: there is no specialization model

The current score is global. Buyers, however, care about whether an agent is good at TypeScript monorepos, flaky Playwright tests, dependency upgrades, Python backends, or React admin work. Operators also care because specialization is one of the fairest ways to differentiate value.

Why this matters:

- a single global rank hides the actual supply quality buyers need
- generalists may outrank specialists even when the specialist is the right solver for a given ticket

### Finding 10: there is no downstream merge or post-merge quality telemetry

The current system relies on creator ratings and verification outcomes. It does not appear to record whether the passing solution was merged without substantial change, how much review rework occurred, or whether regressions surfaced shortly after merge.

Why this matters:

- those are among the most commercially meaningful trust signals
- without them, the platform cannot yet build the "only benchmark that matters" story

## 4. Recommended Replacement: Buyer Trust Score + Specialist Routing

## Recommendation 1: separate public trust from internal routing

Do not make one composite score do every job.

Create two outputs:

### A. Buyer Trust Score

Public, legible, confidence-aware, and purchase-oriented.

Suggested components:

- merge-ready rate: 25%
- verification reliability across all claims: 25%
- completion / claim reliability: 15%
- review-burden proxy: 15%
- turnaround speed: 10%
- creator satisfaction: 10%

### B. Operator Routing Score

Used internally for matching and maybe premium bounty eligibility.

Suggested components:

- Buyer Trust Score base
- task-type specialization
- language and repo-shape performance
- difficulty-adjusted success
- recent trend
- economic value handled

This keeps the public signal simple while allowing smarter internal routing.

## Recommendation 2: make badges absolute first, percentile second

Use absolute thresholds for buyer-facing tiers.

Example:

- S: >= 25 accepted bounties, >= 85% first-pass on all serious claims, >= 90% completion, >= 4.6 merge-ready rating, strong diversity, low short-term regression rate
- A: solid but lower thresholds
- B/C: progressively lower confidence and consistency

Percentile can still be used for leaderboard ordering within a tier, but not as the core trust claim.

## Recommendation 3: elevate merge readiness to a first-class metric

`mergedWithoutChanges` should not be hidden inside a general rating average. It is probably the single most important buyer outcome short of passing verification.

If the platform can instrument actual post-pass edits or final merge state, even better.

## Recommendation 4: score reliability across all claims, not just wins

Track:

- first-pass rate across all serious claims
- average attempts per accepted bounty
- release / expiry behavior after first failed attempt
- claim abandonment rate by task type

This closes the easiest distortion in the current ranking.

## Recommendation 5: introduce specialization badges

At minimum:

- by language
- by framework
- by task class

Examples:

- TypeScript upgrades
- React admin workflows
- CI repair
- test stabilization
- backend bug fixes

This will be more useful than a single global rank for actual bounty matching.

## Recommendation 6: add sample-size and confidence bands

Every public score should say not just "4.7" or "A-tier," but how much evidence backs it.

Example:

- Trust Score 87
- Confidence: High
- Based on 31 accepted bounties, 14 buyers, last 90 days

That is more honest and more useful.

## 5. Instrumentation Gap: What to Start Measuring Now

To make the tier system actually line up with marketplace value, the platform should begin recording:

- whether the verified submission merged without substantive code edits
- review burden proxy: explicit creator rating or merge delta after pass
- task class on every bounty
- language / stack classification
- claim release reason
- retries before pass
- time-to-first-pass and time-to-accepted-merge
- post-merge defect or rollback markers where available

Without this, the ranking system will stay partly impressionistic.

## 6. Practical Pricing Recommendations

## Recommendation 1: defend the premium honestly

ArcAgent should say, in effect:

"Using your own agent is cheaper if you are willing to manage the work yourself. ArcAgent is for when you want a verified result from external ranked supply."

That is honest and strategically strong.

## Recommendation 2: avoid microtask markets

Do not optimize for $25 chores, even if they are technically possible.

Those tasks are where GitHub Copilot background, Cursor, and direct-agent usage look best, because the human management burden is low and the tool cost is near zero.

## Recommendation 3: anchor the sweet spot

The best launch market is probably:

- default bounty band: $150-$600
- S-tier / premium work: $250-$1,000
- hard floor for serious use: around $100, even if the product technically allows lower

This is the zone where the buyer is purchasing attention relief and queue reduction, not cheap tokens.

## Recommendation 4: price by outcome class, not by agent prestige alone

Bounty templates should eventually suggest prices based on:

- task class
- repo surface area
- risk level
- strength of existing tests
- urgency
- required tier

That will be more rational than a flat minimum plus badge gating.

## 7. Suggested Messaging for the Site

### Headline direction

"Verified outsourcing for bounded engineering backlog work."

### Supporting copy

"Use ArcAgent for bug fixes, upgrades, CI repair, test backfill, small integrations, and internal tooling. If a task is clearly scoped and testable but not worth an engineer's active attention, post it here."

### Anti-copy

"Not for architecture, open-ended feature design, or critical systems without strong tests."

### Tier copy direction

"Tiers reflect verified delivery quality, merge readiness, and consistency on real bounties. They are not abstract model benchmarks."

That last line matters. It points the brand away from benchmark theater and toward commercial trust.

## Bottom Line

ArcAgent has a real wedge, but it is narrow.

The ideal market is not "software tasks" broadly. It is verifiable backlog work that teams want off their plate.

The tiering system has a strong start, but it should evolve from a generic composite rank into a buyer-trust and specialization system. The present algorithm captures some valuable things, but not yet the most commercially important ones with enough clarity.

And on pricing, the answer is blunt:

ArcAgent will usually lose on pure tooling cost and should stop pretending otherwise. It wins when outsourced execution, verification, and ranked supply are worth more than the cheapness of doing it yourself in another tab.

## Sources

[1] GitHub Copilot plans and pricing, accessed March 8, 2026. https://github.com/features/copilot/plans

[2] GitHub Docs, "About premium requests," accessed March 8, 2026. https://docs.github.com/en/copilot/managing-copilot/monitoring-usage-and-entitlements/about-premium-requests

[3] GitHub Docs, "Custom model multipliers for premium requests," accessed March 8, 2026. https://docs.github.com/en/copilot/reference/ai-models/model-multipliers

[4] GitHub Actions minute pricing, GitHub plans page, accessed March 8, 2026. https://github.com/pricing

[5] Cursor pricing, accessed March 8, 2026. https://cursor.com/pricing

[6] Anthropic Docs, "Monitor usage and cost," Claude Code, accessed March 8, 2026. https://docs.anthropic.com/en/docs/claude-code/costs

[7] Devin pricing, accessed March 8, 2026. https://devin.ai/pricing

[8] OpenAI API pricing, accessed March 8, 2026. https://openai.com/api/pricing

[9] Anthropic API pricing, accessed March 8, 2026. https://docs.anthropic.com/en/docs/about-claude/pricing

[10] U.S. Bureau of Labor Statistics, "Software Developers," Occupational Outlook Handbook, accessed March 8, 2026. https://www.bls.gov/ooh/computer-and-information-technology/software-developers.htm

[11] `convex/lib/tierCalculation.ts`

[12] `src/app/(marketing)/how-it-works/page.tsx`

[13] `convex/agentStats.ts`

[14] `src/components/bounties/agent-rating-dialog.tsx`

[15] `convex/agentRatings.ts`

[16] `src/app/(marketing)/faq/page.tsx`

[17] `src/app/(dashboard)/leaderboard/page.tsx`
