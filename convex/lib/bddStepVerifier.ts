export interface StepDefinitionFile {
  path: string;
  content: string;
}

export interface StepDefinitionPayload {
  label: string;
  serialized?: string;
}

interface ParsedStepDefinition {
  filePath: string;
  matcher: RegExp;
}

interface GherkinStep {
  source: "public" | "hidden";
  line: number;
  text: string;
}

export interface BddStepVerificationResult {
  valid: boolean;
  issues: string[];
  warnings: string[];
  stats: {
    gherkinSteps: number;
    stepDefinitionFiles: number;
    parsedStepDefinitions: number;
    unmatchedSteps: number;
    invalidDefinitions: number;
  };
}

const GHERKIN_STEP_REGEX = /^\s*(Given|When|Then|And|But)\s+(.+?)\s*$/;
const STEP_DEF_CALL_REGEX =
  /\b(Given|When|Then|And|But)\s*\(\s*(?:(['"`])((?:\\.|(?!\2)[\s\S])*?)\2|\/((?:\\.|[^\/\n])+?)\/([dgimsuvy]*))\s*,/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeJsStringLiteral(raw: string): string {
  let output = "";
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!escaped) {
      if (ch === "\\") {
        escaped = true;
      } else {
        output += ch;
      }
      continue;
    }

    escaped = false;
    switch (ch) {
      case "n":
        output += "\n";
        break;
      case "r":
        output += "\r";
        break;
      case "t":
        output += "\t";
        break;
      case "b":
        output += "\b";
        break;
      case "f":
        output += "\f";
        break;
      case "v":
        output += "\v";
        break;
      case "0":
        output += "\0";
        break;
      default:
        output += ch;
        break;
    }
  }

  if (escaped) output += "\\";
  return output;
}

function normalizeStepDefinitionContent(content: string): string {
  // Some payloads arrive double-escaped ("\\n", "\\\""), which breaks matching.
  if (content.includes("\n")) {
    return content;
  }
  if (!content.includes("\\n") && !content.includes("\\r") && !content.includes("\\t")) {
    return content;
  }
  return content
    .replace(/\\\\/g, "\\")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"");
}

function hasInvalidAlternativeSlash(raw: string): boolean {
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch !== "/") continue;

    const prev = i > 0 ? raw[i - 1] : "";
    const next = i + 1 < raw.length ? raw[i + 1] : "";
    const prevBoundary = i === 0 || /\s/.test(prev);
    const nextBoundary = i === raw.length - 1 || /\s/.test(next);
    if (prevBoundary || nextBoundary) return true;
  }
  return false;
}

function cucumberExpressionToRegex(expression: string): RegExp {
  let pattern = "";
  let last = 0;
  const tokenRegex = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(expression)) !== null) {
    const token = match[1].trim();
    pattern += escapeRegex(expression.slice(last, match.index));
    switch (token) {
      case "int":
        pattern += "-?\\d+";
        break;
      case "float":
        pattern += "-?(?:\\d*\\.\\d+|\\d+)";
        break;
      case "word":
        pattern += "\\S+";
        break;
      case "string":
        pattern += `(?:\"[^\"]*\"|'[^']*'|\\S+)`;
        break;
      default:
        pattern += ".+";
        break;
    }
    last = match.index + match[0].length;
  }

  pattern += escapeRegex(expression.slice(last));
  return new RegExp(`^${pattern}$`);
}

function extractGherkinSteps(content: string, source: "public" | "hidden"): GherkinStep[] {
  const steps: GherkinStep[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(GHERKIN_STEP_REGEX);
    if (!match) continue;
    steps.push({
      source,
      line: i + 1,
      text: match[2].trim(),
    });
  }
  return steps;
}

function parseStepDefinitions(
  files: StepDefinitionFile[],
): {
  parsed: ParsedStepDefinition[];
  issues: string[];
  warnings: string[];
  invalidDefinitions: number;
} {
  const parsed: ParsedStepDefinition[] = [];
  const issues: string[] = [];
  const warnings: string[] = [];
  let invalidDefinitions = 0;

  for (const file of files) {
    const content = normalizeStepDefinitionContent(file.content);
    STEP_DEF_CALL_REGEX.lastIndex = 0;
    let stepDefFoundInFile = false;
    let match: RegExpExecArray | null;
    while ((match = STEP_DEF_CALL_REGEX.exec(content)) !== null) {
      stepDefFoundInFile = true;
      const stringBody = match[3];
      const regexBody = match[4];
      const regexFlags = match[5] ?? "";

      if (typeof stringBody === "string") {
        if (hasInvalidAlternativeSlash(stringBody)) {
          invalidDefinitions++;
          issues.push(
            `Step definition in ${file.path} contains an invalid "/" alternative boundary in expression "${stringBody}"`,
          );
          continue;
        }
        try {
          const decoded = decodeJsStringLiteral(stringBody);
          parsed.push({
            filePath: file.path,
            matcher: cucumberExpressionToRegex(decoded),
          });
        } catch (error) {
          invalidDefinitions++;
          const message = error instanceof Error ? error.message : "unknown error";
          issues.push(`Invalid Cucumber expression in ${file.path}: ${message}`);
        }
        continue;
      }

      if (typeof regexBody === "string") {
        try {
          parsed.push({
            filePath: file.path,
            matcher: new RegExp(regexBody, regexFlags),
          });
        } catch (error) {
          invalidDefinitions++;
          const message = error instanceof Error ? error.message : "unknown error";
          issues.push(`Invalid regex step definition in ${file.path}: ${message}`);
        }
      }
    }

    if (!stepDefFoundInFile) {
      warnings.push(`No Cucumber step definitions found in ${file.path}`);
    }
  }

  return { parsed, issues, warnings, invalidDefinitions };
}

export function loadStepDefinitionFiles(payloads: StepDefinitionPayload[]): {
  files: StepDefinitionFile[];
  issues: string[];
} {
  const files: StepDefinitionFile[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const payload of payloads) {
    const serialized = payload.serialized?.trim() ?? "";
    if (!serialized) continue;

    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(serialized);
    } catch {
      // Backward compatibility: allow raw step-definition source text.
      const path = `inline-${payload.label}.steps`;
      const key = `${path}\0${serialized}`;
      if (!seen.has(key)) {
        files.push({ path, content: serialized });
        seen.add(key);
      }
      continue;
    }

    if (!Array.isArray(parsedValue)) {
      issues.push(`Step definitions payload "${payload.label}" is not a JSON array`);
      continue;
    }

    for (const entry of parsedValue) {
      const path = typeof entry?.path === "string" ? entry.path : "";
      const hasContent = typeof entry?.content === "string";
      const content = hasContent ? entry.content : "";
      if (!path || !hasContent) {
        issues.push(`Step definitions payload "${payload.label}" has an entry missing path/content`);
        continue;
      }
      if (content.trim().length === 0) {
        issues.push(`Step definition file ${path} is empty`);
        continue;
      }
      const key = `${path}\0${content}`;
      if (seen.has(key)) continue;
      files.push({ path, content });
      seen.add(key);
    }
  }

  return { files, issues };
}

export function verifyBddStepCoverage(args: {
  gherkinPublic: string;
  gherkinHidden: string;
  stepDefinitionPayloads: StepDefinitionPayload[];
}): BddStepVerificationResult {
  const issues: string[] = [];
  const warnings: string[] = [];

  const { files, issues: loadIssues } = loadStepDefinitionFiles(args.stepDefinitionPayloads);
  issues.push(...loadIssues);

  if (files.length === 0) {
    issues.push("No step definition files were provided for verification");
  }

  const gherkinSteps = [
    ...extractGherkinSteps(args.gherkinPublic, "public"),
    ...extractGherkinSteps(args.gherkinHidden, "hidden"),
  ];

  const parsedStepDefs = parseStepDefinitions(files);
  issues.push(...parsedStepDefs.issues);
  warnings.push(...parsedStepDefs.warnings);

  let unmatchedSteps = 0;
  for (const step of gherkinSteps) {
    const matched = parsedStepDefs.parsed.some((definition) => {
      definition.matcher.lastIndex = 0;
      return definition.matcher.test(step.text);
    });
    if (!matched) {
      unmatchedSteps++;
      issues.push(
        `Unmatched ${step.source} Gherkin step at line ${step.line}: "${step.text}"`,
      );
    }
  }

  if (parsedStepDefs.parsed.length > 0 && gherkinSteps.length === 0) {
    warnings.push("Step definitions were provided but no Gherkin steps were found to verify");
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
    stats: {
      gherkinSteps: gherkinSteps.length,
      stepDefinitionFiles: files.length,
      parsedStepDefinitions: parsedStepDefs.parsed.length,
      unmatchedSteps,
      invalidDefinitions: parsedStepDefs.invalidDefinitions,
    },
  };
}
