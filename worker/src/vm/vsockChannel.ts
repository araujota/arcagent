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
  type: "exec" | "exec_with_stdin" | "file_write" | "file_read";
  /** Shell command to execute (for exec/exec_with_stdin). */
  command?: string;
  /** User to run the command as (default: current user in guest). */
  user?: string;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** Stdin data to pipe into the command (for exec_with_stdin). */
  stdin?: string;
  /** File path for file_write/file_read. */
  path?: string;
  /** File content for file_write (base64 encoded). */
  contentBase64?: string;
  /** File permissions (octal string, e.g. "0400"). */
  mode?: string;
  /** File owner (e.g. "root:root"). */
  owner?: string;
}

/** Response sent from guest vsock agent to host. */
export interface VsockResponse {
  type: "exec_result" | "file_result" | "error";
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** File content for file_read (base64 encoded). */
  contentBase64?: string;
  error?: string;
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
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await vsockExec(socketPath, "echo ok", 5_000);
      if (result.exitCode === 0 && result.stdout.trim() === "ok") {
        return;
      }
    } catch {
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 3_000);
      logger.debug("Vsock not yet available", { vmId, attempt, nextRetryMs: delay });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`Vsock not reachable for VM ${vmId} after ${maxRetries} retries`);
}
