/**
 * Types for diff-scoped analysis.
 *
 * When a baseCommitSha is available (from the bounty's repoConnection), the
 * worker computes the exact files and lines the agent changed. This context is
 * then used to scope lint/typecheck/security gates so the agent is only held
 * responsible for code they actually modified.
 */

export interface DiffContext {
  /** The base commit SHA (state before agent changes). */
  baseCommitSha: string;
  /** The agent's submission commit SHA. */
  agentCommitSha: string;
  /** Relative paths of all files changed between the two commits. */
  changedFiles: string[];
  /** Map of file path → array of [startLine, endLine] ranges in the agent's version. */
  changedLineRanges: Map<string, [number, number][]>;
}
