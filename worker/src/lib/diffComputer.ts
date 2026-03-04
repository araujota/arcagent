import { VMHandle } from "../vm/firecracker";
import { DiffContext } from "./diffContext";
import { logger } from "../index";
import { sanitizeShellArg } from "./shellSanitize";

const WORKTREE_REF = "WORKTREE";

/**
 * Compute the diff between the base commit and the agent's commit inside the VM.
 *
 * Returns `null` if baseCommitSha is not provided (backwards compatibility —
 * whole-project analysis).
 */
export async function computeDiff(
  vm: VMHandle,
  baseCommitSha: string | undefined,
  agentCommitSha: string,
): Promise<DiffContext | null> {
  if (!baseCommitSha) {
    return null;
  }

  try {
    // Sanitize commit SHAs before shell interpolation
    const safeBase = sanitizeShellArg(baseCommitSha, "commitSha", "baseCommitSha");
    const useWorkingTree = agentCommitSha === WORKTREE_REF;
    const safeAgent = useWorkingTree
      ? null
      : sanitizeShellArg(agentCommitSha, "commitSha", "agentCommitSha");

    // Get list of changed files
    const nameDiffSpec = useWorkingTree
      ? `${safeBase} --`
      : `${safeBase}..${safeAgent}`;
    const nameResult = await vm.exec(
      `cd /workspace && git diff --name-only ${nameDiffSpec} 2>&1`,
      30_000,
    );

    if (nameResult.exitCode !== 0) {
      logger.warn("Failed to compute changed file list", {
        exitCode: nameResult.exitCode,
        output: nameResult.stdout.slice(0, 500),
      });
      return null;
    }

    const changedFiles = nameResult.stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);

    if (changedFiles.length === 0) {
      return {
        baseCommitSha,
        agentCommitSha,
        changedFiles: [],
        changedLineRanges: new Map(),
      };
    }

    // Get unified diff with zero context lines for precise line ranges
    const unifiedDiffSpec = useWorkingTree
      ? `${safeBase} --`
      : `${safeBase}..${safeAgent}`;
    const diffResult = await vm.exec(
      `cd /workspace && git diff -U0 ${unifiedDiffSpec} 2>&1`,
      30_000,
    );

    const changedLineRanges = parseDiffHunks(diffResult.stdout);

    logger.info("Diff computed", {
      changedFiles: changedFiles.length,
      filesWithLineRanges: changedLineRanges.size,
    });

    return {
      baseCommitSha,
      agentCommitSha,
      changedFiles,
      changedLineRanges,
    };
  } catch (err) {
    logger.warn("Failed to compute diff, falling back to whole-project analysis", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Parse `git diff -U0` output to extract changed line ranges per file.
 *
 * Hunk headers look like `@@ -a,b +c,d @@` where:
 * - `+c` is the start line in the new version
 * - `d` is the number of lines added (defaults to 1 if omitted)
 *
 * We only care about the `+` side (lines in the agent's version).
 */
function parseDiffHunks(diffOutput: string): Map<string, [number, number][]> {
  const ranges = new Map<string, [number, number][]>();
  let currentFile: string | null = null;

  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      if (!ranges.has(currentFile)) ranges.set(currentFile, []);
      continue;
    }

    if (!currentFile || !line.startsWith("@@")) {
      continue;
    }

    const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) {
      continue;
    }

    const startLine = Number.parseInt(match[1], 10);
    const lineCount = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    if (lineCount <= 0) {
      continue;
    }

    const endLine = startLine + lineCount - 1;
    ranges.get(currentFile)!.push([startLine, endLine]);
  }

  return ranges;
}
