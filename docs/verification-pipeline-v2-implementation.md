# Verification Pipeline V2 Implementation Writeup

## Objective
Unify all verification checks (build, lint, typecheck, security, Snyk, SonarQube, BDD public/hidden, regression) under one ordered leg engine with:
- standardized per-leg receipts,
- SARIF normalization where possible,
- fail-fast with explicit `unreached` downstream receipts,
- always-on no-new-issues policies,
- durable zipped attempt artifacts,
- compatibility projections for legacy gate/step consumers.

## Codebase Analysis Summary
The previous worker path mixed:
- ordered gate execution (`runGates`) with fail-fast,
- one special test gate with optional per-scenario steps,
- final-only status callback to Convex.

This made it difficult to:
- stream leg-level machine-readable outputs to agents,
- model hidden/public test execution as first-class legs,
- enforce explicit unreached semantics for downstream checks,
- preserve full attempt forensics as a single artifact object.

## Implemented Architecture

### 1) Unified leg engine
Implemented `runVerificationLegs` in:
- `/Users/tyleraraujo/arcagent/worker/src/gates/legRunner.ts`

Leg order:
1. `prepare_environment`
2. `build`
3. `lint_no_new_errors`
4. `typecheck_no_new_errors`
5. `security_no_new_high_critical`
6. `memory`
7. `snyk_no_new_high_critical`
8. `sonarqube_new_code`
9. `bdd_public`
10. `bdd_hidden`
11. `regression_no_new_failures`

Behavior:
- every leg emits a top-level receipt,
- pass legs use `summaryLine: "PASS"`,
- non-pass legs include full `rawBody` from available gate/test output,
- blocking non-pass halts execution and marks all remaining legs `unreached` with `unreachedByLegKey`.

### 2) Receipt contract and transport
Receipt model added in worker types:
- `/Users/tyleraraujo/arcagent/worker/src/queue/jobQueue.ts`

Per-receipt fields include:
- identity: verification/submission/bounty, attempt, leg key, order index,
- status: `pass|fail|error|warning|unreached|skipped_policy`,
- timing: start/end/duration,
- output: summary/raw/sarif/policy/metadata,
- control flow: blocking + unreached source.

Worker streams each receipt as it is produced:
- `postVerificationReceipt()` in `/Users/tyleraraujo/arcagent/worker/src/convex/client.ts`
- called from job processor receipt callback in `/Users/tyleraraujo/arcagent/worker/src/queue/jobProcessor.ts`

### 3) BDD/test as first-class standardized legs
BDD now runs as explicit legs:
- `bdd_public`
- `bdd_hidden`

Implementation:
- reuse `runTestGate` with suite visibility filtering,
- keep per-scenario `steps` for compatibility,
- generate leg SARIF via `buildBddSarif()`.

Files:
- `/Users/tyleraraujo/arcagent/worker/src/gates/legRunner.ts`
- `/Users/tyleraraujo/arcagent/worker/src/lib/sarif.ts`

### 4) Regression as first-class standardized leg
New regression leg:
- `regression_no_new_failures`

Semantics implemented:
- baseline from explicit `baseCommitSha` else merge-base fallback,
- candidate failures from current BDD legs,
- baseline failures from baseline BDD run,
- fail only for newly failing scenarios,
- policy metadata includes `newFailures`, `resolvedFailures`, `unchangedFailures`.

File:
- `/Users/tyleraraujo/arcagent/worker/src/gates/legRunner.ts`

### 4.1) Snyk no-new policy enforcement
The `snyk_no_new_high_critical` leg now evaluates candidate findings against a baseline commit:
- candidate scan runs on the attempt workspace,
- baseline scan runs on `baseCommitSha` (or merge-base fallback),
- the leg only fails when high+critical count increases versus baseline.

If baseline comparison cannot be completed safely, the leg reports `error` with full failure details in receipt output.

### 5) SARIF normalization
Added SARIF helpers:
- `buildGateSarif()`
- `buildBddSarif()`

File:
- `/Users/tyleraraujo/arcagent/worker/src/lib/sarif.ts`

All gate/Bdd legs now attach SARIF when representable.

### 6) Result/receipt/artifact callback surface in Convex
Added new HTTP endpoints in:
- `/Users/tyleraraujo/arcagent/convex/http.ts`

Endpoints:
- `POST /api/verification/receipt`
- `POST /api/verification/artifact`

Security checks enforced consistently with existing worker callback model:
- worker shared secret,
- per-job HMAC,
- callback signature,
- nonce replay protection.

### 7) Persistence model updates
Schema additions:
- `/Users/tyleraraujo/arcagent/convex/schema.ts`

New tables:
- `verificationReceipts`
- `verificationArtifacts`

Data access modules:
- `/Users/tyleraraujo/arcagent/convex/verificationReceipts.ts`
- `/Users/tyleraraujo/arcagent/convex/verificationArtifacts.ts`

Artifact retention:
- 180-day expiry timestamp,
- cleanup cron every 6 hours via:
  - `/Users/tyleraraujo/arcagent/convex/crons.ts`

### 8) Artifact bundle implementation
Each attempt now generates a bundle from worker and uploads to Convex file storage.

Bundle contains:
- `manifest.json`
- `receipts.json`
- `sarif/*.sarif.json`
- `raw/*.log`
- `test/bdd_steps.json`
- `test/regression_delta.json`

Implementation:
- artifact generation in `/Users/tyleraraujo/arcagent/worker/src/queue/jobProcessor.ts`
- upload callback via `postVerificationArtifact()` in `/Users/tyleraraujo/arcagent/worker/src/convex/client.ts`

### 9) Agent/MCP projection updates
Convex status query now includes receipts:
- `/Users/tyleraraujo/arcagent/convex/verifications.ts`

MCP types and rendering now include native receipt output:
- `/Users/tyleraraujo/arcagent/mcp-server/src/lib/types.ts`
- `/Users/tyleraraujo/arcagent/mcp-server/src/tools/getVerificationStatus.ts`
- `/Users/tyleraraujo/arcagent/mcp-server/src/tools/getSubmissionFeedback.ts`

Rendering contract:
- pass receipts show `PASS` line,
- non-pass receipts include full available body and structured policy/SARIF payloads.

### 10) Compatibility projection
Legacy consumers remain functional:
- `gates` and `steps` are still returned,
- source of truth is `validationReceipts`,
- a synthetic legacy `test` gate is derived from BDD/regression leg receipts.

## End-to-end worker flow (new)
1. Clone candidate source.
2. Resolve baseline commit (`baseCommitSha` or merge-base fallback) and build diff context.
3. Execute ordered legs with per-leg receipt emission.
4. Post each receipt to Convex as it completes.
5. Compute overall status from blocking receipts.
6. Post final result payload (including receipts + compatibility gates/steps).
7. Build zip artifact and upload metadata/blob.
8. Destroy VM in `finally`.

## Operational notes for production rollout
- If Snyk/Sonar env vars are absent, those legs emit `skipped_policy` receipts and remain non-blocking in current behavior.
- Hidden test confidentiality is preserved in agent-facing projections while full internal outputs remain in backend artifacts.
- `verificationSteps` compatibility is maintained; downstream migration can move to receipt-native clients incrementally.

## Validation performed
- Worker compile: `npm --prefix worker run build` (pass)
- MCP compile: `npm --prefix mcp-server run build` (pass)
- Worker tests: `npm --prefix worker test` (pass)
- MCP tests: `npm --prefix mcp-server test` (pass)
- Root tests: `npm test` (pass)
- Lint: `npm run lint` (pass; existing repo warnings remain)

## Files touched (implementation)
- `/Users/tyleraraujo/arcagent/convex/schema.ts`
- `/Users/tyleraraujo/arcagent/convex/verificationReceipts.ts`
- `/Users/tyleraraujo/arcagent/convex/verificationArtifacts.ts`
- `/Users/tyleraraujo/arcagent/convex/crons.ts`
- `/Users/tyleraraujo/arcagent/convex/http.ts`
- `/Users/tyleraraujo/arcagent/convex/verifications.ts`
- `/Users/tyleraraujo/arcagent/mcp-server/src/lib/types.ts`
- `/Users/tyleraraujo/arcagent/mcp-server/src/tools/getVerificationStatus.ts`
- `/Users/tyleraraujo/arcagent/mcp-server/src/tools/getSubmissionFeedback.ts`
- `/Users/tyleraraujo/arcagent/worker/src/api/routes.ts`
- `/Users/tyleraraujo/arcagent/worker/src/convex/client.ts`
- `/Users/tyleraraujo/arcagent/worker/src/queue/jobQueue.ts`
- `/Users/tyleraraujo/arcagent/worker/src/queue/jobProcessor.ts`
- `/Users/tyleraraujo/arcagent/worker/src/gates/legRunner.ts`
- `/Users/tyleraraujo/arcagent/worker/src/lib/sarif.ts`

## Test updates
- `/Users/tyleraraujo/arcagent/worker/src/queue/jobProcessor.test.ts`
- `/Users/tyleraraujo/arcagent/worker/src/workerLifecycle.test.ts`
- `/Users/tyleraraujo/arcagent/worker/src/lifecycleIntegration.test.ts`
