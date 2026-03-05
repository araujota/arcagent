import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuidv4 } from "uuid";
import type { FirecrackerVMOptions, ExecResult, VMHandle } from "./firecracker";
import type { VsockRequest, VsockResponse } from "./vsockChannel";
import { logger } from "../index";
import { execFileAsync } from "../lib/execFileAsync";
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_EXECUTION_USER = process.env.PROCESS_BACKEND_EXEC_USER ?? "agent";
const DEFAULT_PATH = process.env.PROCESS_BACKEND_PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

interface ProcessSession {
  cwd: string;
}

interface ProcessWorkspaceFile {
  path: string;
  relativePath: string;
  mtimeMs: number;
}

interface GrepSearchState {
  fileMatchCounts: Map<string, number>;
  grepMatches: NonNullable<VsockResponse["matches"]>;
  totalMatches: number;
}

const DEFAULT_GLOB_MAX_RESULTS = 500;
const DEFAULT_GREP_MAX_RESULTS = 200;

export interface ProcessVMHandle extends VMHandle {
  __backend: "process";
  __rootDir: string;
  __workspaceDir: string;
  __sessions: Map<string, ProcessSession>;
  __startedAt: number;
  __executionUser: string;
  __dropPrivileges: boolean;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function rewriteWorkspacePaths(command: string, workspaceDir: string): string {
  return command.replace(/\/workspace\b/g, workspaceDir);
}

function normalizeVmPath(path: string, workspaceDir: string): string {
  if (path.startsWith("/workspace")) {
    return rewriteWorkspacePaths(path, workspaceDir);
  }
  if (path.startsWith("/")) {
    return path;
  }
  return resolve(workspaceDir, path);
}

function hasBinary(binary: string): boolean {
  try {
    execFileSync("bash", ["-lc", `command -v ${binary} >/dev/null 2>&1`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function userExists(username: string): Promise<boolean> {
  try {
    await execFileAsync("id", ["-u", username]);
    return true;
  } catch {
    return false;
  }
}

async function groupExists(groupName: string): Promise<boolean> {
  if (!hasBinary("getent")) return false;
  try {
    await execFileAsync("getent", ["group", groupName]);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutionUserShell(): string {
  if (process.env.PROCESS_BACKEND_EXEC_SHELL) {
    return process.env.PROCESS_BACKEND_EXEC_SHELL;
  }
  return hasBinary("bash") ? "/bin/bash" : "/bin/sh";
}

function getExecErrorMessage(err: unknown): string {
  const execErr = err as { stderr?: string; message?: string };
  const stderr = execErr.stderr?.trim();
  if (stderr) return stderr;
  return execErr.message ?? String(err);
}

async function ensureExecutionUserExists(username: string): Promise<void> {
  if (await userExists(username)) return;

  const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (!runningAsRoot) {
    throw new Error(
      `Process backend execution user '${username}' does not exist and worker is not running as root. ` +
      `Pre-create '${username}' in the worker image or host bootstrap.`,
    );
  }

  if (!hasBinary("useradd")) {
    throw new Error(
      `Process backend execution user '${username}' does not exist and useradd is unavailable`,
    );
  }

  const shell = resolveExecutionUserShell();
  const shouldCreateGroup = !(await groupExists(username));
  const useraddArgs = ["-m", "-s", shell];
  if (shouldCreateGroup) useraddArgs.push("-U");
  useraddArgs.push(username);
  try {
    await execFileAsync("useradd", useraddArgs);
  } catch (err) {
    logger.warn("Failed to create process backend execution user with useradd", {
      username,
      shell,
      useraddArgs: useraddArgs.join(" "),
      error: getExecErrorMessage(err),
    });
    // Another concurrent worker may have created the user; verify before failing.
  }

  if (!(await userExists(username))) {
    throw new Error(
      `Process backend execution user '${username}' does not exist after bootstrap. ` +
      `Ensure '${username}' is present in the worker image/host bootstrap.`,
    );
  }
}

function buildScrubbedEnv(workspaceDir: string, executionUser: string): Record<string, string> {
  return {
    PATH: DEFAULT_PATH,
    HOME: process.env.PROCESS_BACKEND_HOME ?? workspaceDir,
    USER: executionUser,
    LOGNAME: executionUser,
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: process.env.TERM ?? "xterm-256color",
    ARCAGENT_WORKSPACE_DIR: workspaceDir,
  };
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  workspaceDir: string,
  executionUser: string,
  dropPrivileges: boolean,
): Promise<ExecResult> {
  const rewritten = rewriteWorkspacePaths(command, workspaceDir);
  const shellCmd = `cd ${shellEscape(cwd)} && ${rewritten}`;
  const scrubbedEnv = buildScrubbedEnv(workspaceDir, executionUser);

  try {
    let stdout = "";
    let stderr = "";

    if (dropPrivileges) {
      if (!hasBinary("runuser")) {
        throw new Error("runuser binary is required to execute process backend commands as an unprivileged user");
      }
      const envArgs = [
        "env",
        "-i",
        ...Object.entries(scrubbedEnv).map(([key, value]) => `${key}=${value}`),
        "bash",
        "-lc",
        shellCmd,
      ];
      const result = await execFileAsync("runuser", ["-u", executionUser, "--", ...envArgs], {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } else {
      const result = await execFileAsync("bash", ["-lc", shellCmd], {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: scrubbedEnv,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    }

    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const error = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
      signal?: string;
      killed?: boolean;
    };

    const exitCode = typeof error.code === "number" ? error.code : 1;
    const stderr = error.stderr ?? error.message ?? "Command failed";
    const timeoutSuffix = error.signal === "SIGTERM" || error.killed
      ? "\nCommand timed out"
      : "";

    return {
      stdout: error.stdout ?? "",
      stderr: `${stderr}${timeoutSuffix}`,
      exitCode,
    };
  }
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function escapeRegexChar(char: string): string {
  return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function findMatchingBrace(pattern: string, start: number): number {
  let depth = 0;
  for (let i = start; i < pattern.length; i += 1) {
    if (pattern[i] === "{") {
      depth += 1;
    } else if (pattern[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(
  pattern: string,
  delimiter: string,
  start = 0,
): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = start;
  for (let i = start; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (char === delimiter && depth === 0) {
      parts.push(pattern.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(pattern.slice(last));
  return parts;
}

function globSegmentToRegex(pattern: string): string {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      regex += "[^/]*";
      i += 1;
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      i += 1;
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        regex += "\\[";
        i += 1;
        continue;
      }
      regex += `[${pattern.slice(i + 1, end)}]`;
      i = end + 1;
      continue;
    }
    if (char === "{") {
      const end = findMatchingBrace(pattern, i);
      if (end === -1) {
        regex += "\\{";
        i += 1;
        continue;
      }
      const alternatives = splitTopLevel(pattern.slice(i + 1, end), ",").map((alt) =>
        globSegmentToRegex(alt),
      );
      regex += `(?:${alternatives.join("|")})`;
      i = end + 1;
      continue;
    }
    regex += escapeRegexChar(char);
    i += 1;
  }
  return regex;
}

const globSegmentRegexCache = new Map<string, RegExp>();

function segmentMatches(pattern: string, target: string): boolean {
  let compiled = globSegmentRegexCache.get(pattern);
  if (!compiled) {
    compiled = new RegExp(`^${globSegmentToRegex(pattern)}$`);
    globSegmentRegexCache.set(pattern, compiled);
  }
  return compiled.test(target);
}

function matchGlobPattern(pattern: string, target: string): boolean {
  const normalizedPattern = toPosixPath(pattern).replace(/^\/+/, "");
  const normalizedTarget = toPosixPath(target);
  const patternParts = normalizedPattern.split("/").filter((p) => p.length > 0);
  const targetParts = normalizedTarget.split("/").filter((p) => p.length > 0);

  const memo = new Map<string, boolean>();

  const matchParts = (patternIndex: number, targetIndex: number): boolean => {
    const key = `${patternIndex}:${targetIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    if (patternIndex >= patternParts.length) {
      return targetIndex >= targetParts.length;
    }

    const part = patternParts[patternIndex];
    if (part === "**") {
      // ** matches any number of segments, including zero.
      for (let skip = 0; targetIndex + skip <= targetParts.length; skip += 1) {
        if (matchParts(patternIndex + 1, targetIndex + skip)) {
          memo.set(key, true);
          return true;
        }
      }
      memo.set(key, false);
      return false;
    }

    if (targetIndex >= targetParts.length) {
      memo.set(key, false);
      return false;
    }

    if (!segmentMatches(part, targetParts[targetIndex])) {
      memo.set(key, false);
      return false;
    }

    const matches = matchParts(patternIndex + 1, targetIndex + 1);
    memo.set(key, matches);
    return matches;
  };

  return matchParts(0, 0);
}

function isBinaryBuffer(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 4096));
  return sample.includes(0);
}

async function safeReadDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function safeRealPath(path: string): Promise<string | null> {
  try {
    return toPosixPath(await realpath(path));
  } catch {
    return null;
  }
}

function isWithinBasePath(path: string, normalizedBase: string): boolean {
  return path === normalizedBase || path.startsWith(`${normalizedBase}/`);
}

function toWorkspaceRelativePath(path: string, normalizedBase: string): string | null {
  const relativePath = relative(normalizedBase, path).split("/").join("/");
  if (relativePath.startsWith("..")) return null;
  return relativePath;
}

async function addWorkspaceFileIfApplicable(
  childPath: string,
  stats: Stats,
  normalizedBase: string,
  files: ProcessWorkspaceFile[],
): Promise<void> {
  if (!stats.isFile()) return;
  const resolvedPath = await safeRealPath(childPath);
  if (!resolvedPath || !isWithinBasePath(resolvedPath, normalizedBase)) return;
  const relativePath = toWorkspaceRelativePath(resolvedPath, normalizedBase);
  if (!relativePath) return;
  files.push({
    path: resolvedPath,
    relativePath,
    mtimeMs: stats.mtimeMs,
  });
}

async function walkWorkspaceDir(
  current: string,
  normalizedBase: string,
  seen: Set<string>,
  files: ProcessWorkspaceFile[],
): Promise<void> {
  const entries = await safeReadDir(current);
  for (const entry of entries) {
    const childPath = toPosixPath(`${current}/${entry.name}`);
    const stats = await safeStat(childPath);
    if (!stats) continue;

    const inodeKey = `${stats.dev}:${stats.ino}`;
    if (seen.has(inodeKey)) continue;
    seen.add(inodeKey);

    if (stats.isDirectory()) {
      const resolvedDir = await safeRealPath(childPath);
      if (!resolvedDir || !isWithinBasePath(resolvedDir, normalizedBase)) continue;
      await walkWorkspaceDir(childPath, normalizedBase, seen, files);
      continue;
    }

    await addWorkspaceFileIfApplicable(childPath, stats, normalizedBase, files);
  }
}

async function collectWorkspaceFiles(basePath: string): Promise<ProcessWorkspaceFile[]> {
  const normalizedBase = toPosixPath(await realpath(basePath));
  const files: ProcessWorkspaceFile[] = [];
  const seen = new Set<string>();
  await walkWorkspaceDir(normalizedBase, normalizedBase, seen, files);
  return files;
}

async function handleFileGlobRequest(
  handle: ProcessVMHandle,
  request: VsockRequest,
): Promise<VsockResponse> {
  const pattern = request.pattern ?? "";
  if (!pattern) {
    return { type: "error", error: "missing pattern" };
  }

  const searchPath = normalizeVmPath(request.path ?? handle.__workspaceDir, handle.__workspaceDir);
  if (!searchPath.startsWith(handle.__workspaceDir)) {
    return { type: "error", error: "Path must be within /workspace" };
  }

  const maxResults = request.maxResults && request.maxResults > 0
    ? request.maxResults
    : DEFAULT_GLOB_MAX_RESULTS;

  const files = await collectWorkspaceFiles(searchPath);
  const matched = files.filter((file) => matchGlobPattern(pattern, file.relativePath));
  const sorted = [...matched].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const truncated = sorted.length > maxResults;
  const selected = truncated ? sorted.slice(0, maxResults) : sorted;

  return {
    type: "file_result",
    files: selected.map((entry) => entry.path),
    totalMatches: sorted.length,
    truncated,
  };
}

function buildCaseSensitiveRegex(pattern: string): RegExp {
  return new RegExp(pattern);
}

function buildCaseInsensitiveRegex(pattern: string): RegExp {
  return new RegExp(pattern, "i");
}

function recordFileMatch(state: GrepSearchState, filePath: string): void {
  state.totalMatches += 1;
  state.fileMatchCounts.set(filePath, (state.fileMatchCounts.get(filePath) ?? 0) + 1);
}

function buildContextLines(
  lines: string[],
  lineIndex: number,
  contextLines: number,
): { before: string[]; after: string[] } {
  const beforeStart = Math.max(lineIndex - contextLines, 0);
  const afterEnd = Math.min(lineIndex + contextLines + 1, lines.length);
  return {
    before: lines.slice(beforeStart, lineIndex).map((text) => text.replace(/\r?\n$/, "")),
    after: lines.slice(lineIndex + 1, afterEnd).map((text) => text.replace(/\r?\n$/, "")),
  };
}

function maybeAppendContentMatch(
  state: GrepSearchState,
  filePath: string,
  line: string,
  lineIndex: number,
  lines: string[],
  contextLines: number,
  maxResults: number,
): void {
  if (state.grepMatches.length >= maxResults) return;
  const context = buildContextLines(lines, lineIndex, contextLines);
  state.grepMatches.push({
    file: filePath,
    line: lineIndex + 1,
    text: line.replace(/\r?\n$/, ""),
    contextBefore: context.before,
    contextAfter: context.after,
  });
}

async function scanFileForGrep(
  file: ProcessWorkspaceFile,
  searchRegex: RegExp,
  request: VsockRequest,
  state: GrepSearchState,
  maxResults: number,
): Promise<void> {
  if (request.glob && !matchGlobPattern(request.glob, file.relativePath)) return;

  const contentBuffer = await readFile(file.path);
  if (isBinaryBuffer(contentBuffer)) return;
  const fileContent = contentBuffer.toString("utf-8");
  const lines = fileContent.split(/\r?\n/);
  const contextLines = Math.max(0, request.contextLines ?? 0);
  const outputMode = request.outputMode ?? "content";

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (searchRegex.global) {
      searchRegex.lastIndex = 0;
    }
    if (!searchRegex.test(line)) continue;

    recordFileMatch(state, file.path);
    if (outputMode === "content") {
      maybeAppendContentMatch(state, file.path, line, lineIndex, lines, contextLines, maxResults);
    }
  }
}

function buildGrepResponse(outputMode: string, state: GrepSearchState, maxResults: number): VsockResponse {
  const truncated = state.totalMatches > maxResults;

  if (outputMode === "files_with_matches") {
    return {
      type: "file_result",
      files: Array.from(state.fileMatchCounts.keys()),
      totalMatches: state.totalMatches,
      truncated,
    };
  }

  if (outputMode === "count") {
    const counts = Array.from(state.fileMatchCounts.entries()).map(([file, count]) => ({
      file,
      line: 0,
      text: String(count),
    }));
    return {
      type: "file_result",
      matches: counts,
      totalMatches: state.totalMatches,
      truncated,
    };
  }

  return {
    type: "file_result",
    matches: state.grepMatches,
    totalMatches: state.totalMatches,
    truncated,
  };
}

async function handleFileGrepRequest(
  handle: ProcessVMHandle,
  request: VsockRequest,
): Promise<VsockResponse> {
  const pattern = request.pattern ?? "";
  if (!pattern) {
    return { type: "error", error: "missing pattern" };
  }

  const searchPath = normalizeVmPath(request.path ?? handle.__workspaceDir, handle.__workspaceDir);
  if (!searchPath.startsWith(handle.__workspaceDir)) {
    return { type: "error", error: "Path must be within /workspace" };
  }

  const maxResults = request.maxResults && request.maxResults > 0
    ? request.maxResults
    : DEFAULT_GREP_MAX_RESULTS;
  const caseSensitive = request.caseSensitive ?? true;
  const outputMode = request.outputMode ?? "content";

  let searchRegex: RegExp;
  try {
    searchRegex = caseSensitive
      ? buildCaseSensitiveRegex(pattern)
      : buildCaseInsensitiveRegex(pattern);
  } catch (err) {
    return {
      type: "error",
      error: err instanceof Error ? err.message : "invalid pattern",
    };
  }

  const files = await collectWorkspaceFiles(searchPath);
  const state: GrepSearchState = {
    fileMatchCounts: new Map<string, number>(),
    grepMatches: [],
    totalMatches: 0,
  };

  for (const file of files) {
    await scanFileForGrep(file, searchRegex, request, state, maxResults);
  }

  return buildGrepResponse(outputMode, state, maxResults);
}

async function handleSessionRequest(
  handle: ProcessVMHandle,
  request: VsockRequest,
): Promise<VsockResponse> {
  const sessionId = request.sessionId ?? "default";

  if (request.type === "session_create") {
    handle.__sessions.set(sessionId, { cwd: handle.__workspaceDir });
    return {
      type: "session_result",
      sessionId,
      cwd: "/workspace",
      exitCode: 0,
    };
  }

  if (request.type === "session_destroy") {
    handle.__sessions.delete(sessionId);
    return { type: "session_result", sessionId, exitCode: 0 };
  }

  if (request.type === "session_resize") {
    return { type: "session_result", sessionId, exitCode: 0 };
  }

  const session = handle.__sessions.get(sessionId);
  if (!session) {
    return { type: "error", error: `Session not found: ${sessionId}` };
  }

  const rawCommand = request.command ?? "";
  const marker = `__ARC_CWD__${uuidv4()}`;
  const result = await runCommand(
    `${rawCommand}\nprintf '\\n${marker}%s' "$PWD"`,
    session.cwd,
    request.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    handle.__workspaceDir,
    handle.__executionUser,
    handle.__dropPrivileges,
  );

  let stdout = result.stdout;
  let cwd = session.cwd;
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex >= 0) {
    const newCwd = stdout.slice(markerIndex + marker.length).trim();
    if (newCwd) {
      cwd = newCwd;
      session.cwd = newCwd;
    }
    stdout = stdout.slice(0, markerIndex);
  }

  return {
    type: "session_result",
    sessionId,
    stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    cwd: cwd.replace(handle.__workspaceDir, "/workspace"),
  };
}

async function handleFileEditRequest(
  handle: ProcessVMHandle,
  request: VsockRequest,
): Promise<VsockResponse> {
  const targetPath = normalizeVmPath(request.path ?? "", handle.__workspaceDir);
  const oldString = request.oldString ?? "";
  const newString = request.newString ?? "";
  const replaceAll = request.replaceAll ?? false;

  if (oldString.length === 0) {
    return { type: "error", error: "oldString must not be empty" };
  }

  if (!targetPath.startsWith(handle.__workspaceDir)) {
    return { type: "error", error: "Path must be within /workspace" };
  }

  const original = await readFile(targetPath, "utf-8");
  const occurrences = original.split(oldString).length - 1;

  if (occurrences === 0) {
    return { type: "file_result", replacements: 0, error: "not_found" };
  }
  if (occurrences > 1 && !replaceAll) {
    return { type: "file_result", replacements: 0, error: "ambiguous" };
  }

  const next = replaceAll
    ? original.split(oldString).join(newString)
    : original.replace(oldString, newString);

  await writeFile(targetPath, next, "utf-8");
  return {
    type: "file_result",
    replacements: replaceAll ? occurrences : 1,
  };
}

export async function createProcessVM(opts: FirecrackerVMOptions): Promise<VMHandle> {
  const vmId = `proc-${uuidv4().slice(0, 8)}`;
  const rootDir = await mkdtemp(`${tmpdir()}/arcagent-${vmId}-`);
  const workspaceDir = `${rootDir}/workspace`;
  await mkdir(workspaceDir, { recursive: true });
  const executionUser = DEFAULT_EXECUTION_USER;
  const dropPrivileges = typeof process.getuid === "function" && process.getuid() === 0;

  if (dropPrivileges) {
    await ensureExecutionUserExists(executionUser);
    await execFileAsync("chown", ["-R", `${executionUser}:${executionUser}`, rootDir]).catch(() => {
      throw new Error(`Failed to chown process backend workspace to '${executionUser}'`);
    });
  }

  logger.info("Creating process execution environment", {
    vmId,
    jobId: opts.jobId,
    rootDir,
    executionUser,
    dropPrivileges,
  });

  const handle: ProcessVMHandle = {
    vmId,
    jobId: opts.jobId,
    guestIp: "127.0.0.1",
    __backend: "process",
    __rootDir: rootDir,
    __workspaceDir: workspaceDir,
    __sessions: new Map<string, ProcessSession>(),
    __startedAt: Date.now(),
    __executionUser: executionUser,
    __dropPrivileges: dropPrivileges,

    async exec(command: string, timeoutMs = DEFAULT_EXEC_TIMEOUT_MS, user?: string): Promise<ExecResult> {
      const requestedRoot = user === "root";
      const commandUser = requestedRoot ? "root" : executionUser;
      const commandDropsPrivileges = requestedRoot ? false : dropPrivileges;
      return runCommand(
        command,
        workspaceDir,
        timeoutMs,
        workspaceDir,
        commandUser,
        commandDropsPrivileges,
      );
    },

    async execWithStdin(
      command: string,
      stdin: string,
      timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
      user?: string,
    ): Promise<ExecResult> {
      const requestedRoot = user === "root";
      const commandUser = requestedRoot ? "root" : executionUser;
      const commandDropsPrivileges = requestedRoot ? false : dropPrivileges;
      const rewritten = rewriteWorkspacePaths(command, workspaceDir);
      const stdinEscaped = shellEscape(stdin);
      // Apply stdin redirection to the entire command chain.
      // Without grouping, `<<<` binds only to the last simple command (e.g. chown),
      // which can leave earlier commands like `cat > file` waiting on stdin.
      const commandWithStdin = `( ${rewritten} ) <<< ${stdinEscaped}`;
      return runCommand(
        commandWithStdin,
        workspaceDir,
        timeoutMs,
        workspaceDir,
        commandUser,
        commandDropsPrivileges,
      );
    },

    async writeFile(path: string, content: Buffer, mode?: string, owner?: string): Promise<void> {
      const targetPath = normalizeVmPath(path, workspaceDir);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content);

      if (mode) {
        await chmod(targetPath, parseInt(mode, 8)).catch(() => {});
      }
      if (owner) {
        await execFileAsync("chown", [owner, targetPath]).catch(() => {});
      }
    },

    async vsockRequest(request: VsockRequest): Promise<VsockResponse> {
      try {
        if (
          request.type === "session_create" ||
          request.type === "session_exec" ||
          request.type === "session_resize" ||
          request.type === "session_destroy"
        ) {
          return handleSessionRequest(handle, request);
        }

        if (request.type === "file_edit") {
          return handleFileEditRequest(handle, request);
        }

        if (request.type === "file_glob") {
          return handleFileGlobRequest(handle, request);
        }

        if (request.type === "file_grep") {
          return handleFileGrepRequest(handle, request);
        }

        if (request.type === "heartbeat") {
          return {
            type: "heartbeat_result",
            uptimeMs: Date.now() - handle.__startedAt,
            sessionCount: handle.__sessions.size,
          };
        }

        return {
          type: "error",
          error: `vsock request type not supported in process backend: ${request.type}`,
        };
      } catch (err) {
        return {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  return handle;
}

export function isProcessHandle(handle: VMHandle): handle is ProcessVMHandle {
  return (handle as ProcessVMHandle).__backend === "process";
}

export async function destroyProcessVM(handle: ProcessVMHandle): Promise<void> {
  handle.__sessions.clear();
  await rm(handle.__rootDir, { recursive: true, force: true });
}
