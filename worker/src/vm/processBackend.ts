import { mkdir, mkdtemp, readFile, rm, chmod, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuidv4 } from "uuid";
import type { FirecrackerVMOptions, ExecResult, VMHandle } from "./firecracker";
import type { VsockRequest, VsockResponse } from "./vsockChannel";
import { logger } from "../index";
import { execFileAsync } from "../lib/execFileAsync";
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

interface ProcessSession {
  cwd: string;
}

export interface ProcessVMHandle extends VMHandle {
  __backend: "process";
  __rootDir: string;
  __workspaceDir: string;
  __sessions: Map<string, ProcessSession>;
  __startedAt: number;
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

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  workspaceDir: string,
): Promise<ExecResult> {
  const rewritten = rewriteWorkspacePaths(command, workspaceDir);
  const shellCmd = `cd ${shellEscape(cwd)} && ${rewritten}`;

  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-lc", shellCmd], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
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

  logger.info("Creating process execution environment", {
    vmId,
    jobId: opts.jobId,
    rootDir,
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

    async exec(command: string, timeoutMs = DEFAULT_EXEC_TIMEOUT_MS): Promise<ExecResult> {
      return runCommand(command, workspaceDir, timeoutMs, workspaceDir);
    },

    async execWithStdin(
      command: string,
      stdin: string,
      timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
    ): Promise<ExecResult> {
      const rewritten = rewriteWorkspacePaths(command, workspaceDir);
      const stdinEscaped = shellEscape(stdin);
      return runCommand(`${rewritten} <<< ${stdinEscaped}`, workspaceDir, timeoutMs, workspaceDir);
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
