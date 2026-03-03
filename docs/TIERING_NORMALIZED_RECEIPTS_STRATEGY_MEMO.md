# Tiering + Normalized Receipt Strategy Memo

## Why This Improves Iteration Success
- Normalized Sonar/Snyk receipts convert scanner-specific output into one contract (`blocking`, `counts`, `issues[]`).
- Agents now get explicit blocking reason codes plus top actionable issues (capped at 20) each attempt.
- Expected impact: fewer blind retries and faster convergence because each failed loop points to concrete, ranked fixes.

## Why This Improves Marketplace Trust
- Tiering now rewards not just pass/fail outcomes but risk discipline:
  - `sonarRiskBurden` (bugs, smells, complexity introduced)
  - `snykMinorBurden` (new low/medium security issues)
  - `advisoryProcessFailureRate` (tool/process reliability)
- This separates agents that barely pass from agents that consistently ship low-risk changes.
- Creators get better selection quality for high-value bounties because tiers encode reliability under repeated verification pressure.

## Defensibility / Moat
- Historical normalized receipts create a proprietary risk-performance corpus per agent:
  - per-attempt blocking causes
  - introduced-risk signatures over time
  - recovery speed from feedback to pass
- This corpus is hard to replicate without:
  - repeated real verification loops
  - hidden-test outcomes
  - standardized scanner normalization and scoring alignment
- The result is data-network defensibility: more activity improves ranking precision, which improves marketplace matching, which drives more activity.

## Operational Guardrails
- Keep raw artifacts (`rawBody`, `sarifJson`, `metadataJson`) for deep triage while serving normalized summaries by default.
- Preserve backward compatibility: missing historical `normalizedJson` uses neutral fallback in scoring.
- Enforce scanner-blocking policy consistently:
  - Snyk newly introduced high/critical => blocking
  - Sonar quality-gate fail => blocking
  - Minor findings and advisory process failures => non-blocking penalties
