import { VMHandle } from "../vm/firecracker";
import { GateResult } from "../queue/jobQueue";
import { DiffContext } from "../lib/diffContext";
import { filterToChangedLines } from "../lib/diffFilter";
import { parseJsonSafe } from "../lib/resultParser";

/**
 * Security gate -- runs Trivy (vulnerability scanner), Semgrep (SAST), and
 * language-specific SAST tools (Bandit, gosec, Brakeman, etc.).
 *
 * All scanners run on the full project. When DiffContext is available, findings
 * are post-hoc filtered to only report issues in files/lines the agent changed.
 *
 * The gate fails if any HIGH or CRITICAL severity issues are found in the
 * agent's changed code.
 */
export async function runSecurityGate(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
  diff: DiffContext | null,
): Promise<GateResult> {
  const start = Date.now();

  // Split timeout across scanners
  const scannerTimeout = Math.floor(timeoutMs / 3);

  // 1. Run Trivy filesystem scan
  const trivyResult = await runTrivy(vm, scannerTimeout);

  // 2. Run Semgrep SAST
  const semgrepResult = await runSemgrep(vm, language, scannerTimeout);

  // 3. Run language-specific SAST
  const langSastResult = await runLanguageSast(vm, language, scannerTimeout);

  const durationMs = Date.now() - start;

  // Post-hoc filter findings if diff context is available
  const trivyFindings = trivyResult.findings;
  let semgrepFindings = semgrepResult.findings;
  let langSastFindings = langSastResult.findings;

  if (diff && diff.changedLineRanges.size > 0) {
    semgrepFindings = filterToChangedLines(
      semgrepFindings as SemgrepFinding[],
      (f) => f.path,
      (f) => f.start?.line,
      diff.changedLineRanges,
    );

    langSastFindings = filterToChangedLines(
      langSastFindings as LanguageSastFinding[],
      (f) => f.file,
      (f) => f.line,
      diff.changedLineRanges,
    );

    // Trivy findings are typically dependency-level, not file-scoped, so no filter
  }

  // Recount severities after filtering
  const totalHigh = countSeverity(trivyFindings, "HIGH") +
    countSeverity(semgrepFindings, "HIGH") +
    countSeverity(langSastFindings, "HIGH");
  const totalCritical = countSeverity(trivyFindings, "CRITICAL") +
    countSeverity(semgrepFindings, "CRITICAL") +
    countSeverity(langSastFindings, "CRITICAL");
  const totalFindings = trivyFindings.length + semgrepFindings.length + langSastFindings.length;

  const hasBlockingIssues = totalHigh > 0 || totalCritical > 0;

  return {
    gate: "security",
    status: hasBlockingIssues ? "fail" : "pass",
    durationMs,
    summary: hasBlockingIssues
      ? `Security scan found ${totalCritical} critical and ${totalHigh} high severity issue(s)`
      : `Security scan passed (${totalFindings} low/medium finding(s))`,
    details: {
      trivy: { ...trivyResult, findings: trivyFindings.slice(0, 50) },
      semgrep: { ...semgrepResult, findings: semgrepFindings.slice(0, 50) },
      languageSast: { ...langSastResult, findings: langSastFindings.slice(0, 50) },
      totalFindings,
      criticalCount: totalCritical,
      highCount: totalHigh,
      diffScoped: diff !== null,
    },
  };
}

// ---------------------------------------------------------------------------
// Severity counting
// ---------------------------------------------------------------------------

function countSeverity(findings: unknown[], level: string): number {
  let count = 0;
  for (const f of findings) {
    const severity = getSeverity(f);
    if (severity === level) count++;
  }
  return count;
}

function getSeverity(finding: unknown): string {
  if (!finding || typeof finding !== "object") return "";
  const f = finding as Record<string, unknown>;

  // Trivy format
  if (typeof f.Severity === "string") return f.Severity.toUpperCase();
  // Semgrep format
  const extra = f.extra as Record<string, unknown> | undefined;
  if (extra && typeof extra.severity === "string") {
    const s = extra.severity.toUpperCase();
    if (s === "ERROR") return "CRITICAL";
    if (s === "WARNING") return "HIGH";
    return s;
  }
  // Language SAST format
  if (typeof f.severity === "string") return f.severity.toUpperCase();
  return "";
}

// ---------------------------------------------------------------------------
// Trivy
// ---------------------------------------------------------------------------

interface ScanSummary {
  totalFindings: number;
  criticalCount: number;
  highCount: number;
  findings: unknown[];
  error?: string;
}

async function runTrivy(
  vm: VMHandle,
  timeoutMs: number,
): Promise<ScanSummary> {
  const result = await vm.exec(
    "cd /workspace && trivy fs --format json --severity HIGH,CRITICAL --scanners vuln,secret . 2>/dev/null",
    timeoutMs,
  );

  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return {
      totalFindings: 0,
      criticalCount: 0,
      highCount: 0,
      findings: [],
      error: `Trivy exited with code ${result.exitCode}: ${truncate(result.stderr, 500)}`,
    };
  }

  const parsed = parseJsonSafe<TrivyReport>(result.stdout);

  if (!parsed || !parsed.Results) {
    return {
      totalFindings: 0,
      criticalCount: 0,
      highCount: 0,
      findings: [],
      error: "Failed to parse Trivy output",
    };
  }

  let criticalCount = 0;
  let highCount = 0;
  const findings: TrivyVulnerability[] = [];

  for (const target of parsed.Results) {
    for (const vuln of target.Vulnerabilities ?? []) {
      findings.push(vuln);
      if (vuln.Severity === "CRITICAL") criticalCount++;
      if (vuln.Severity === "HIGH") highCount++;
    }
  }

  return {
    totalFindings: findings.length,
    criticalCount,
    highCount,
    findings: findings.slice(0, 50),
  };
}

interface TrivyReport {
  Results?: TrivyTarget[];
}

interface TrivyTarget {
  Target?: string;
  Vulnerabilities?: TrivyVulnerability[];
}

interface TrivyVulnerability {
  VulnerabilityID?: string;
  PkgName?: string;
  Severity?: string;
  Title?: string;
}

// ---------------------------------------------------------------------------
// Semgrep
// ---------------------------------------------------------------------------

async function runSemgrep(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
): Promise<ScanSummary> {
  const config = getSemgrepConfig(language);

  const result = await vm.exec(
    `cd /workspace && semgrep --config ${config} --json --quiet . 2>/dev/null`,
    timeoutMs,
  );

  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return {
      totalFindings: 0,
      criticalCount: 0,
      highCount: 0,
      findings: [],
      error: `Semgrep exited with code ${result.exitCode}: ${truncate(result.stderr, 500)}`,
    };
  }

  const parsed = parseJsonSafe<SemgrepReport>(result.stdout);

  if (!parsed || !parsed.results) {
    return {
      totalFindings: 0,
      criticalCount: 0,
      highCount: 0,
      findings: [],
      error: "Failed to parse Semgrep output",
    };
  }

  let criticalCount = 0;
  let highCount = 0;

  for (const finding of parsed.results) {
    const severity = finding.extra?.severity?.toUpperCase();
    if (severity === "ERROR" || severity === "CRITICAL") criticalCount++;
    if (severity === "WARNING" || severity === "HIGH") highCount++;
  }

  return {
    totalFindings: parsed.results.length,
    criticalCount,
    highCount,
    findings: parsed.results.slice(0, 50),
  };
}

interface SemgrepReport {
  results?: SemgrepFinding[];
}

interface SemgrepFinding {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  extra?: {
    severity?: string;
    message?: string;
  };
}

function getSemgrepConfig(language: string): string {
  switch (language.toLowerCase()) {
    case "typescript":
    case "javascript":
      return "p/javascript";
    case "python":
      return "p/python";
    case "go":
      return "p/golang";
    case "rust":
      return "p/rust";
    case "java":
      return "p/java";
    case "ruby":
      return "p/ruby";
    case "php":
      return "p/php";
    case "csharp":
      return "p/csharp";
    case "c":
    case "cpp":
      return "p/c";
    case "swift":
      return "p/swift";
    case "kotlin":
      return "p/kotlin";
    default:
      return "p/default";
  }
}

// ---------------------------------------------------------------------------
// Language-specific SAST
// ---------------------------------------------------------------------------

interface LanguageSastFinding {
  file?: string;
  line?: number;
  severity?: string;
  message?: string;
  tool?: string;
}

async function runLanguageSast(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
): Promise<ScanSummary> {
  const command = getLanguageSastCommand(language);

  if (!command) {
    return { totalFindings: 0, criticalCount: 0, highCount: 0, findings: [] };
  }

  const result = await vm.exec(
    `cd /workspace && ${command} 2>/dev/null`,
    timeoutMs,
  );

  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return {
      totalFindings: 0,
      criticalCount: 0,
      highCount: 0,
      findings: [],
      error: `Language SAST exited with code ${result.exitCode}`,
    };
  }

  return parseLanguageSastOutput(language, result.stdout);
}

function getLanguageSastCommand(language: string): string | null {
  switch (language.toLowerCase()) {
    case "python":
      return "bandit -r . -f json 2>/dev/null";
    case "go":
      return "gosec -fmt=json ./... 2>/dev/null";
    case "ruby":
      return "brakeman -f json --no-pager 2>/dev/null";
    case "java":
      return (
        "if [ -f pom.xml ]; then " +
        "  mvn com.github.spotbugs:spotbugs-maven-plugin:spotbugs -q 2>&1 && " +
        "  cat target/spotbugsXml.xml 2>/dev/null; " +
        "else echo '{}'; fi"
      );
    case "rust":
      return "cargo audit --json 2>/dev/null";
    case "c":
    case "cpp":
      return "flawfinder --json . 2>/dev/null";
    default:
      return null;
  }
}

type LanguageSastParser = (output: string) => ScanSummary;

const LANGUAGE_SAST_PARSERS: Record<string, LanguageSastParser> = {
  python: parseBanditOutput,
  go: parseGosecOutput,
  ruby: parseBrakemanOutput,
  rust: parseCargoAuditOutput,
  c: parseFlawfinderOutput,
  cpp: parseFlawfinderOutput,
};

function parseLanguageSastOutput(language: string, output: string): ScanSummary {
  const parser = LANGUAGE_SAST_PARSERS[language.toLowerCase()];
  return parser ? parser(output) : emptyScanSummary();
}

function emptyScanSummary(): ScanSummary {
  return { totalFindings: 0, criticalCount: 0, highCount: 0, findings: [] };
}

function parseBanditOutput(output: string): ScanSummary {
  const parsed = parseJsonSafe<BanditOutput>(output);
  if (!parsed?.results) return emptyScanSummary();

  let highCount = 0;
  const findings: LanguageSastFinding[] = [];
  for (const result of parsed.results) {
    const severity = result.issue_severity?.toUpperCase();
    if (severity === "HIGH") highCount++;
    findings.push({
      file: result.filename,
      line: result.line_number,
      severity,
      message: result.issue_text,
      tool: "bandit",
    });
  }

  return { totalFindings: findings.length, criticalCount: 0, highCount, findings };
}

function parseGosecOutput(output: string): ScanSummary {
  const parsed = parseJsonSafe<GosecOutput>(output);
  if (!parsed?.Issues) return emptyScanSummary();

  let criticalCount = 0;
  let highCount = 0;
  const findings: LanguageSastFinding[] = [];
  for (const issue of parsed.Issues) {
    const severity = issue.severity?.toUpperCase();
    if (severity === "HIGH") highCount++;
    if (severity === "CRITICAL") criticalCount++;
    findings.push({
      file: issue.file,
      line: typeof issue.line === "string" ? parseInt(issue.line, 10) : issue.line,
      severity,
      message: issue.details,
      tool: "gosec",
    });
  }

  return { totalFindings: findings.length, criticalCount, highCount, findings };
}

function parseBrakemanOutput(output: string): ScanSummary {
  const parsed = parseJsonSafe<BrakemanOutput>(output);
  if (!parsed?.warnings) return emptyScanSummary();

  let highCount = 0;
  const findings: LanguageSastFinding[] = [];
  for (const warning of parsed.warnings) {
    const confidence = warning.confidence?.toUpperCase();
    if (confidence === "HIGH") highCount++;
    findings.push({
      file: warning.file,
      line: warning.line,
      severity: confidence === "HIGH" ? "HIGH" : "MEDIUM",
      message: warning.message,
      tool: "brakeman",
    });
  }

  return { totalFindings: findings.length, criticalCount: 0, highCount, findings };
}

function parseCargoAuditOutput(output: string): ScanSummary {
  const parsed = parseJsonSafe<CargoAuditOutput>(output);
  const vulnerabilities = parsed?.vulnerabilities?.list;
  if (!vulnerabilities) return emptyScanSummary();

  const findings: LanguageSastFinding[] = [];
  for (const vulnerability of vulnerabilities) {
    const advisory = vulnerability.advisory;
    findings.push({
      file: advisory?.id,
      severity: "HIGH",
      message: advisory?.title,
      tool: "cargo-audit",
    });
  }

  return {
    totalFindings: findings.length,
    criticalCount: 0,
    highCount: findings.length,
    findings,
  };
}

function parseFlawfinderOutput(output: string): ScanSummary {
  const parsed = parseJsonSafe<FlawfinderFinding[]>(output);
  if (!parsed) return emptyScanSummary();

  let highCount = 0;
  const findings: LanguageSastFinding[] = [];
  for (const finding of parsed) {
    const level = finding.level ?? 0;
    const severity = level >= 4 ? "HIGH" : level >= 2 ? "MEDIUM" : "LOW";
    if (severity === "HIGH") highCount++;
    findings.push({
      file: finding.filename,
      line: finding.line,
      severity,
      message: finding.warning,
      tool: "flawfinder",
    });
  }

  return { totalFindings: findings.length, criticalCount: 0, highCount, findings };
}

// ---------------------------------------------------------------------------
// Language SAST types
// ---------------------------------------------------------------------------

interface BanditOutput {
  results?: {
    filename?: string;
    line_number?: number;
    issue_severity?: string;
    issue_text?: string;
  }[];
}

interface GosecOutput {
  Issues?: {
    file?: string;
    line?: string | number;
    severity?: string;
    details?: string;
  }[];
}

interface BrakemanOutput {
  warnings?: {
    file?: string;
    line?: number;
    confidence?: string;
    message?: string;
  }[];
}

interface CargoAuditOutput {
  vulnerabilities?: {
    list?: {
      advisory?: {
        id?: string;
        title?: string;
      };
    }[];
  };
}

interface FlawfinderFinding {
  filename?: string;
  line?: number;
  level?: number;
  warning?: string;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (truncated)";
}
