/**
 * Vsock communication channel for Firecracker microVMs.
 *
 * Replaces SSH-over-TAP with Firecracker's native virtio-vsock, which is a
 * point-to-point channel between host kernel and guest VM that never touches
 * the network stack. Access is restricted by Unix domain socket permissions.
 *
 * Protocol: length-prefixed JSON framing
 *   [4 bytes uint32 BE length][JSON payload]
 */

import { connect, Socket } from "node:net";
import { logger } from "../index";
import { ExecResult } from "./firecracker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Request sent from host to guest vsock agent. */
export interface VsockRequest {
  type:
    | "exec"
    | "exec_with_stdin"
    | "file_write"
    | "file_read"
    | "file_edit"
    | "file_glob"
    | "file_grep"
    | "session_create"
    | "session_exec"
    | "session_resize"
    | "session_destroy"
    | "heartbeat";
  /** Shell command to execute (for exec/exec_with_stdin/session_exec). */
  command?: string;
  /** User to run the command as (default: "agent"). */
  user?: string;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** Stdin data to pipe into the command (for exec_with_stdin). */
  stdin?: string;
  /** File path for file_write/file_read/file_edit/file_glob/file_grep. */
  path?: string;
  /** File content for file_write (base64 encoded). */
  contentBase64?: string;
  /** File permissions (octal string, e.g. "0400"). */
  mode?: string;
  /** File owner (e.g. "root:root"). */
  owner?: string;
  // --- file_edit fields ---
  /** Exact text to find (for file_edit). */
  oldString?: string;
  /** Replacement text (for file_edit). */
  newString?: string;
  /** Replace all occurrences (for file_edit, default false). */
  replaceAll?: boolean;
  // --- file_glob fields ---
  /** Glob pattern (for file_glob, e.g. "**\/*.ts"). */
  pattern?: string;
  /** Maximum number of results (for file_glob/file_grep). */
  maxResults?: number;
  // --- file_grep fields ---
  /** File glob filter (for file_grep, e.g. "*.ts"). */
  glob?: string;
  /** Case-sensitive search (for file_grep, default true). */
  caseSensitive?: boolean;
  /** Number of context lines around matches (for file_grep). */
  contextLines?: number;
  /** Output mode (for file_grep). */
  outputMode?: "content" | "files_with_matches" | "count";
  // --- session fields ---
  /** Session ID (for session_create/exec/resize/destroy). */
  sessionId?: string;
  /** Shell path (for session_create, default "/bin/bash"). */
  shell?: string;
  /** Initial environment variables (for session_create). */
  env?: Record<string, string>;
  /** PTY rows (for session_create/session_resize). */
  rows?: number;
  /** PTY cols (for session_create/session_resize). */
  cols?: number;
}

/** Response sent from guest vsock agent to host. */
export interface VsockResponse {
  type: "exec_result" | "file_result" | "error" | "heartbeat_result" | "session_result";
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** File content for file_read (base64 encoded). */
  contentBase64?: string;
  error?: string;
  // --- file_edit response ---
  /** Number of replacements made (for file_edit). */
  replacements?: number;
  // --- file_glob response ---
  /** Matching file paths (for file_glob). */
  files?: string[];
  /** Total number of matches before truncation (for file_glob/file_grep). */
  totalMatches?: number;
  /** Whether results were truncated (for file_glob/file_grep). */
  truncated?: boolean;
  // --- file_grep response ---
  /** Search matches (for file_grep). */
  matches?: Array<{
    file: string;
    line: number;
    text: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }>;
  // --- session response ---
  /** Session ID (for session_create). */
  sessionId?: string;
  /** Current working directory (for session_exec). */
  cwd?: string;
  // --- heartbeat response ---
  /** VM uptime in ms (for heartbeat). */
  uptimeMs?: number;
  /** Number of active PTY sessions (for heartbeat). */
  sessionCount?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default vsock port the guest agent listens on. */
const VSOCK_PORT = 5000;

/** Connection timeout in milliseconds. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Default command execution timeout. */
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Vsock Client
// ---------------------------------------------------------------------------

/**
 * Execute a command inside the guest VM via vsock.
 */
export async function vsockExec(
  socketPath: string,
  command: string,
  timeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS,
  user?: string,
): Promise<ExecResult> {
  const request: VsockRequest = {
    type: "exec",
    command,
    user,
    timeoutMs,
  };

  const response = await sendVsockRequest(socketPath, request, timeoutMs);

  return {
    stdout: response.stdout ?? "",
    stderr: response.stderr ?? "",
    exitCode: response.exitCode ?? 1,
  };
}

/**
 * Execute a command with stdin piped via vsock.
 * Used for injecting step definitions without writing them to agent-visible paths.
 */
export async function vsockExecWithStdin(
  socketPath: string,
  command: string,
  stdin: string,
  timeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS,
  user?: string,
): Promise<ExecResult> {
  const request: VsockRequest = {
    type: "exec_with_stdin",
    command,
    stdin,
    user,
    timeoutMs,
  };

  const response = await sendVsockRequest(socketPath, request, timeoutMs);

  return {
    stdout: response.stdout ?? "",
    stderr: response.stderr ?? "",
    exitCode: response.exitCode ?? 1,
  };
}

/**
 * Write a file inside the guest VM via vsock.
 * Allows setting permissions and ownership (for root-owned step def injection).
 */
export async function vsockWriteFile(
  socketPath: string,
  path: string,
  content: Buffer,
  mode?: string,
  owner?: string,
): Promise<void> {
  const request: VsockRequest = {
    type: "file_write",
    path,
    contentBase64: content.toString("base64"),
    mode,
    owner,
  };

  const response = await sendVsockRequest(socketPath, request, 30_000);

  if (response.type === "error") {
    throw new Error(`vsock file write failed: ${response.error}`);
  }
}

// ---------------------------------------------------------------------------
// Low-level framing
// ---------------------------------------------------------------------------

/**
 * Send a length-prefixed JSON request over the vsock UDS and read the response.
 */
async function sendVsockRequest(
  socketPath: string,
  request: VsockRequest,
  timeoutMs: number,
): Promise<VsockResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`vsock request timed out after ${timeoutMs}ms`));
    }, timeoutMs + CONNECT_TIMEOUT_MS);

    const socket: Socket = connect({ path: socketPath }, () => {
      // Send length-prefixed JSON
      const payload = Buffer.from(JSON.stringify(request), "utf-8");
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length, 0);
      socket.write(Buffer.concat([header, payload]));
    });

    const chunks: Buffer[] = [];

    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);

      // Try to parse a complete response
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) return;

      const expectedLen = buf.readUInt32BE(0);
      if (buf.length < 4 + expectedLen) return;

      // We have a full response
      const jsonBuf = buf.subarray(4, 4 + expectedLen);
      clearTimeout(timer);
      socket.destroy();

      try {
        const response: VsockResponse = JSON.parse(jsonBuf.toString("utf-8"));
        resolve(response);
      } catch (err) {
        reject(new Error(`Failed to parse vsock response: ${err}`));
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`vsock connection error: ${err.message}`));
    });

    socket.on("close", () => {
      clearTimeout(timer);
      // If we didn't resolve yet, the connection closed prematurely
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) {
        reject(new Error("vsock connection closed without response"));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Connection Pool
// ---------------------------------------------------------------------------

/**
 * Pool of persistent vsock connections per socket path (per VM).
 * Connections are reused across requests. If the guest agent closes
 * the connection after responding (no keep-alive), the pool gracefully
 * falls back to creating new connections.
 */
export class VsockPool {
  private pool = new Map<string, Socket[]>(); // socketPath → idle sockets
  private maxPerVM: number;

  constructor(maxPerVM = 4) {
    this.maxPerVM = maxPerVM;
  }

  /**
   * Acquire a connected socket from the pool or create a new one.
   */
  async acquire(socketPath: string): Promise<Socket> {
    const idle = this.pool.get(socketPath);
    if (idle && idle.length > 0) {
      const socket = idle.pop()!;
      // Verify socket is still connected
      if (!socket.destroyed && socket.writable) {
        return socket;
      }
      // Socket was closed — discard and create new
      socket.destroy();
    }

    // Create a new connection
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`VsockPool: connect timeout for ${socketPath}`));
      }, CONNECT_TIMEOUT_MS);

      const socket = connect({ path: socketPath }, () => {
        clearTimeout(timer);
        resolve(socket);
      });

      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`VsockPool: connect error: ${err.message}`));
      });
    });
  }

  /**
   * Return a connection to the pool for reuse (or destroy if pool full).
   */
  release(socketPath: string, socket: Socket): void {
    if (socket.destroyed || !socket.writable) {
      return; // don't pool dead sockets
    }

    let idle = this.pool.get(socketPath);
    if (!idle) {
      idle = [];
      this.pool.set(socketPath, idle);
    }

    if (idle.length >= this.maxPerVM) {
      socket.destroy();
      return;
    }

    // Remove all listeners to prevent leaks
    socket.removeAllListeners("data");
    socket.removeAllListeners("error");
    socket.removeAllListeners("close");

    // If socket closes while idle, just let it go
    socket.once("error", () => {
      socket.destroy();
      const arr = this.pool.get(socketPath);
      if (arr) {
        const idx = arr.indexOf(socket);
        if (idx >= 0) arr.splice(idx, 1);
      }
    });
    socket.once("close", () => {
      const arr = this.pool.get(socketPath);
      if (arr) {
        const idx = arr.indexOf(socket);
        if (idx >= 0) arr.splice(idx, 1);
      }
    });

    idle.push(socket);
  }

  /**
   * Destroy all connections for a VM (called on VM destroy).
   */
  destroy(socketPath: string): void {
    const idle = this.pool.get(socketPath);
    if (idle) {
      for (const socket of idle) {
        socket.destroy();
      }
      this.pool.delete(socketPath);
    }
  }

  /**
   * Destroy all pooled connections (for shutdown).
   */
  destroyAll(): void {
    for (const [, sockets] of this.pool) {
      for (const socket of sockets) {
        socket.destroy();
      }
    }
    this.pool.clear();
  }

  /**
   * Number of idle connections for a given socket path.
   */
  idleCount(socketPath: string): number {
    return this.pool.get(socketPath)?.length ?? 0;
  }
}

/** Global vsock connection pool instance. */
export const vsockPool = new VsockPool();

/**
 * Send a vsock request using a pooled connection.
 * Falls back to a new connection if pooled connection fails.
 */
export async function sendVsockRequestPooled(
  socketPath: string,
  request: VsockRequest,
  timeoutMs: number,
): Promise<VsockResponse> {
  let socket: Socket;
  try {
    socket = await vsockPool.acquire(socketPath);
  } catch {
    // Fall back to non-pooled
    return sendVsockRequest(socketPath, request, timeoutMs);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`vsock pooled request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Optimized buffer handling: track offset instead of O(n²) concat on every chunk
    let buf = Buffer.alloc(0);
    let resolved = false;

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      if (buf.length < 4) return;
      const expectedLen = buf.readUInt32BE(0);
      if (buf.length < 4 + expectedLen) return;

      // Full response received
      resolved = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);

      const jsonBuf = buf.subarray(4, 4 + expectedLen);

      // Try to return to pool — if guest supports keep-alive, this saves reconnect time
      vsockPool.release(socketPath, socket);

      try {
        const response: VsockResponse = JSON.parse(jsonBuf.toString("utf-8"));
        resolve(response);
      } catch (err) {
        reject(new Error(`Failed to parse vsock response: ${err}`));
      }
    };

    socket.on("data", onData);

    socket.once("error", (err) => {
      if (!resolved) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`vsock pooled connection error: ${err.message}`));
      }
    });

    socket.once("close", () => {
      if (!resolved) {
        clearTimeout(timer);
        // Connection closed before full response — guest doesn't support keep-alive
        // Fall back to non-pooled for this request
        if (buf.length === 0) {
          sendVsockRequest(socketPath, request, timeoutMs).then(resolve, reject);
        }
      }
    });

    // Send the request
    const payload = Buffer.from(JSON.stringify(request), "utf-8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    socket.write(Buffer.concat([header, payload]));
  });
}

// ---------------------------------------------------------------------------
// Connection waiting
// ---------------------------------------------------------------------------

/**
 * Poll until the guest vsock agent is available.
 * Replaces waitForSSH with a much faster check (~50ms vs ~200ms+ for SSH).
 */
export async function waitForVsock(
  socketPath: string,
  vmId: string,
  maxRetries: number = 20,
  baseDelayMs: number = 100,
): Promise<void> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await vsockExec(socketPath, "echo ok", 5_000);
      if (result.exitCode === 0 && result.stdout.trim() === "ok") {
        return;
      }
      lastError = `unexpected response: exitCode=${result.exitCode}, stdout=${result.stdout.trim() || "<empty>"}, stderr=${result.stderr.trim() || "<empty>"}`;
    } catch (err) {
      // Keep the last low-level connection error for terminal diagnostics.
      // This is critical for distinguishing guest boot failures from transient delays.
      lastError = err instanceof Error ? err.message : String(err);
    }
    const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 3_000);
    logger.debug("Vsock not yet available", { vmId, attempt, nextRetryMs: delay });
    await new Promise((r) => setTimeout(r, delay));
  }
  const suffix = lastError ? `; lastError=${lastError}` : "";
  const message = `Vsock not reachable for VM ${vmId} after ${maxRetries} retries${suffix}`;
  logger.warn("Vsock readiness check failed", {
    vmId,
    maxRetries,
    lastError: lastError ?? undefined,
  });
  throw new Error(message);
}
