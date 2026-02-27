import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, chmod, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

    async exec(command: string, timeoutMs = DEFAULT_EXEC_TIMEOUT_MS): Promise<ExecResult> {
      return runCommand(
        command,
        workspaceDir,
        timeoutMs,
        workspaceDir,
        executionUser,
        dropPrivileges,
      );
    },

    async execWithStdin(
      command: string,
      stdin: string,
      timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
    ): Promise<ExecResult> {
      const rewritten = rewriteWorkspacePaths(command, workspaceDir);
      const stdinEscaped = shellEscape(stdin);
      return runCommand(
        `${rewritten} <<< ${stdinEscaped}`,
        workspaceDir,
        timeoutMs,
        workspaceDir,
        executionUser,
        dropPrivileges,
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
