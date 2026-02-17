/**
 * Agent-breed abstraction layer.
 *
 * Different AI agent runtimes (Claude Code, Codex, generic) have different
 * tool naming conventions and preferred interaction modes. ToolProfiles map
 * canonical tool names to agent-specific aliases and configure defaults.
 *
 * Usage:
 *   const profile = getToolProfile("codex");
 *   const toolName = profile.toolAliases["workspace_exec"] ?? "workspace_exec";
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolProfile {
  /** Profile identifier (e.g. "claude-code", "codex", "generic"). */
  name: string;

  /**
   * Maps canonical tool names to agent-specific aliases.
   * If a canonical name is not in the map, use it as-is.
   *
   * Example: { "workspace_apply_patch": "apply_patch" } means Codex
   * agents see the tool as "apply_patch" instead of "workspace_apply_patch".
   */
  toolAliases: Record<string, string>;

  /**
   * Preferred shell execution mode for this agent breed.
   *
   * - "stateless": Each command runs in a fresh shell (workspace_exec).
   *   Better for agents that issue independent, self-contained commands.
   * - "persistent": Commands run in a persistent session (workspace_shell).
   *   Better for agents that rely on cd, env vars, and shell state.
   */
  defaultShellMode: "stateless" | "persistent";
}

// ---------------------------------------------------------------------------
// Profile Definitions
// ---------------------------------------------------------------------------

const claudeCodeProfile: ToolProfile = {
  name: "claude-code",
  toolAliases: {
    // Claude Code natively uses workspace_* naming — no aliases needed.
    // The persistent shell is the preferred mode for Claude Code agents
    // since they naturally chain commands with cd and env vars.
  },
  defaultShellMode: "persistent",
};

const codexProfile: ToolProfile = {
  name: "codex",
  toolAliases: {
    // Codex agents are trained on apply_patch as their primary edit tool.
    // Map the V4A adapter to the name Codex models expect.
    "workspace_apply_patch": "apply_patch",
    // Codex prefers shorter tool names without the workspace_ prefix
    "workspace_exec": "shell",
    "workspace_shell": "shell_session",
    "workspace_read_file": "read_file",
    "workspace_write_file": "write_file",
    "workspace_edit_file": "edit_file",
    "workspace_glob": "glob",
    "workspace_grep": "grep",
    "workspace_list_files": "list_files",
    "workspace_search": "search",
    "workspace_batch_read": "batch_read",
    "workspace_batch_write": "batch_write",
    "workspace_crash_reports": "crash_reports",
  },
  defaultShellMode: "stateless",
};

const genericProfile: ToolProfile = {
  name: "generic",
  toolAliases: {
    // Generic agents use canonical names with no aliases.
  },
  defaultShellMode: "stateless",
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const profiles: Record<string, ToolProfile> = {
  "claude-code": claudeCodeProfile,
  codex: codexProfile,
  generic: genericProfile,
};

/**
 * Get a tool profile by name.
 *
 * @param profileName - Profile identifier. Falls back to "generic" if
 *   not recognized or not provided.
 * @returns The matching ToolProfile.
 */
export function getToolProfile(profileName?: string): ToolProfile {
  if (!profileName) return genericProfile;
  return profiles[profileName] ?? genericProfile;
}

/**
 * Resolve a canonical tool name to the agent-specific alias
 * for the given profile.
 *
 * @param profile - The active tool profile.
 * @param canonicalName - The canonical tool name (e.g. "workspace_exec").
 * @returns The alias if one exists, otherwise the canonical name.
 */
export function resolveToolName(
  profile: ToolProfile,
  canonicalName: string,
): string {
  return profile.toolAliases[canonicalName] ?? canonicalName;
}

/**
 * Build a reverse lookup from alias back to canonical name.
 * Useful when receiving tool calls from agents that use aliases.
 *
 * @param profile - The active tool profile.
 * @returns A map from alias to canonical name.
 */
export function buildReverseLookup(
  profile: ToolProfile,
): Record<string, string> {
  const reverse: Record<string, string> = {};
  for (const [canonical, alias] of Object.entries(profile.toolAliases)) {
    reverse[alias] = canonical;
  }
  return reverse;
}

/**
 * List all available profile names.
 */
export function listProfileNames(): string[] {
  return Object.keys(profiles);
}
