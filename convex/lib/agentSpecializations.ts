import { v } from "convex/values";

export const AGENT_SPECIALIZATION_TAXONOMY_VERSION = 1;
export const MAX_SPECIALIZATIONS_PER_BUCKET = 5;

export const AGENT_SPECIALIZATION_LANGUAGES = [
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "ruby",
  "php",
  "csharp",
] as const;

export const AGENT_SPECIALIZATION_FRAMEWORKS = [
  "react",
  "nextjs",
  "node",
  "express",
  "django",
  "fastapi",
  "flask",
  "rails",
  "laravel",
  "spring",
  "playwright",
  "pytest",
  "tailwind",
] as const;

export const AGENT_SPECIALIZATION_TASK_TYPES = [
  "bug_fixes",
  "dependency_upgrades",
  "lint_type_cleanup",
  "test_backfill",
  "flaky_test_fixes",
  "small_integrations",
  "codemods_migrations",
  "ci_build_repair",
  "internal_tools",
] as const;

export type AgentSpecializationLanguage = typeof AGENT_SPECIALIZATION_LANGUAGES[number];
export type AgentSpecializationFramework = typeof AGENT_SPECIALIZATION_FRAMEWORKS[number];
export type AgentSpecializationTaskType = typeof AGENT_SPECIALIZATION_TASK_TYPES[number];
export type ConfidenceLevel = "low" | "medium" | "high";

export type AgentSpecializationsInput = {
  taxonomyVersion?: number;
  languages?: string[];
  frameworks?: string[];
  taskTypes?: string[];
};

export type AgentSpecializations = {
  taxonomyVersion: number;
  languages: AgentSpecializationLanguage[];
  frameworks: AgentSpecializationFramework[];
  taskTypes: AgentSpecializationTaskType[];
};

function makeLiteralUnionValidator<const T extends readonly string[]>(values: T) {
  return v.union(...values.map((value) => v.literal(value)));
}

export const confidenceLevelValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
);

export const agentSpecializationsValidator = v.object({
  taxonomyVersion: v.number(),
  languages: v.array(makeLiteralUnionValidator(AGENT_SPECIALIZATION_LANGUAGES)),
  frameworks: v.array(makeLiteralUnionValidator(AGENT_SPECIALIZATION_FRAMEWORKS)),
  taskTypes: v.array(makeLiteralUnionValidator(AGENT_SPECIALIZATION_TASK_TYPES)),
});

function normalizeBucket<T extends readonly string[]>(
  values: string[] | undefined,
  allowedValues: T,
  bucketName: string,
): T[number][] {
  if (!values || values.length === 0) return [];

  const deduped = [...new Set(values)];
  if (deduped.length > MAX_SPECIALIZATIONS_PER_BUCKET) {
    throw new Error(
      `${bucketName} cannot contain more than ${MAX_SPECIALIZATIONS_PER_BUCKET} entries`,
    );
  }

  const allowedSet = new Set<string>(allowedValues);
  for (const value of deduped) {
    if (!allowedSet.has(value)) {
      throw new Error(`Invalid ${bucketName} value: ${value}`);
    }
  }

  return deduped as T[number][];
}

export function normalizeAgentSpecializations(
  input?: AgentSpecializationsInput,
): AgentSpecializations | undefined {
  if (!input) return undefined;

  const taxonomyVersion = input.taxonomyVersion ?? AGENT_SPECIALIZATION_TAXONOMY_VERSION;
  if (taxonomyVersion !== AGENT_SPECIALIZATION_TAXONOMY_VERSION) {
    throw new Error(`Unsupported specialization taxonomy version: ${taxonomyVersion}`);
  }

  return {
    taxonomyVersion,
    languages: normalizeBucket(input.languages, AGENT_SPECIALIZATION_LANGUAGES, "languages"),
    frameworks: normalizeBucket(
      input.frameworks,
      AGENT_SPECIALIZATION_FRAMEWORKS,
      "frameworks",
    ),
    taskTypes: normalizeBucket(
      input.taskTypes,
      AGENT_SPECIALIZATION_TASK_TYPES,
      "taskTypes",
    ),
  };
}
