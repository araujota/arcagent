/**
 * Express routes for workspace operations.
 *
 * All routes require WORKER_SHARED_SECRET bearer auth (reuse existing authMiddleware).
 * These endpoints are called directly by the MCP server for low-latency interactive work.
 */

import { Router, Request, Response } from "express";
import { logger } from "../index";
import {
  provisionWorkspace,
  getSession,
  destroyWorkspace,
  extractDiff,
  touchActivity,
  extendTTL,
} from "./sessionManager";

// ---------------------------------------------------------------------------
// Output limits
// ---------------------------------------------------------------------------

const MAX_STDOUT = 200 * 1024; // 200 KB
const MAX_STDERR = 50 * 1024; // 50 KB
const MAX_FILE_READ_LINES = 2000;
const MAX_FILE_WRITE_BYTES = 1 * 1024 * 1024; // 1 MB
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const MAX_EXEC_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Blocked commands (for dev VM safety)
// ---------------------------------------------------------------------------

const BLOCKED_COMMANDS = ["poweroff", "shutdown", "reboot", "halt", "init 0"];

function isBlockedCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  return BLOCKED_COMMANDS.some(
    (blocked) =>
      trimmed === blocked ||
      trimmed.startsWith(`${blocked} `) ||
      trimmed.includes(`&& ${blocked}`) ||
      trimmed.includes(`; ${blocked}`),
  );
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * SECURITY (W3): Validate that a file path resolves within /workspace/.
 * Prevents directory traversal attacks.
 */
function validateWorkspacePath(rawPath: string): string {
  // Normalize: prepend /workspace/ if relative
  let resolved = rawPath;
  if (!resolved.startsWith("/")) {
    resolved = `/workspace/${resolved}`;
  }

  // Resolve .. components
  const parts = resolved.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      stack.pop();
    } else if (part !== "" && part !== ".") {
      stack.push(part);
    }
  }
  const normalized = "/" + stack.join("/");

  if (!normalized.startsWith("/workspace/") && normalized !== "/workspace") {
    throw new Error("Path must be within /workspace/");
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Truncation helpers
// ---------------------------------------------------------------------------

function truncate(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, "utf-8") <= maxBytes) return str;
  const buf = Buffer.from(str, "utf-8");
  const truncated = buf.subarray(0, maxBytes).toString("utf-8");
  return truncated + "\n... [output truncated]";
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createWorkspaceRoutes(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /workspace/provision — Create dev VM, clone repo
  // -------------------------------------------------------------------------
  router.post("/workspace/provision", async (req: Request, res: Response) => {
    try {
      const {
        workspaceId,
        claimId,
        bountyId,
        agentId,
        repoUrl,
        commitSha,
        language,
        expiresAt,
      } = req.body as {
        workspaceId: string;
        claimId: string;
        bountyId: string;
        agentId: string;
        repoUrl: string;
        commitSha: string;
        language: string;
        expiresAt: number;
      };

      if (!workspaceId || !claimId || !bountyId || !agentId || !repoUrl || !commitSha) {
        res.status(400).json({ error: "Missing required fields" });
        return;
      }

      const session = await provisionWorkspace({
        workspaceId,
        claimId,
        bountyId,
        agentId,
        repoUrl,
        commitSha,
        language: language ?? "typescript",
        expiresAt: expiresAt ?? Date.now() + 4 * 60 * 60 * 1000,
      });

      res.json({
        workspaceId: session.workspaceId,
        vmId: session.vmHandle.vmId,
        status: session.status,
        workerHost: process.env.WORKER_HOST_URL || `http://localhost:${process.env.PORT ?? "3001"}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to provision workspace";
      logger.error("Workspace provision failed", { error: message });
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/exec — Run command in dev VM
  // -------------------------------------------------------------------------
  router.post("/workspace/exec", async (req: Request, res: Response) => {
    try {
      const { workspaceId, command, timeoutMs } = req.body as {
        workspaceId: string;
        command: string;
        timeoutMs?: number;
      };

      if (!workspaceId || !command) {
        res.status(400).json({ error: "Missing workspaceId or command" });
        return;
      }

      if (isBlockedCommand(command)) {
        res.status(400).json({ error: "Command not allowed in workspace" });
        return;
      }

      const session = getSession(workspaceId);
      if (!session || session.status !== "ready") {
        res.status(404).json({ error: "Workspace not found or not ready" });
        return;
      }

      touchActivity(workspaceId);

      const timeout = Math.min(
        timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
        MAX_EXEC_TIMEOUT_MS,
      );

      // SECURITY (W2): Commands always run as non-root "agent" user
      const result = await session.vmHandle.exec(command, timeout, "agent");

      res.json({
        stdout: truncate(result.stdout, MAX_STDOUT),
        stderr: truncate(result.stderr, MAX_STDERR),
        exitCode: result.exitCode,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Exec failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/read-file — Read file from dev VM
  // -------------------------------------------------------------------------
  router.post("/workspace/read-file", async (req: Request, res: Response) => {
    try {
      const { workspaceId, path, offset, limit } = req.body as {
        workspaceId: string;
        path: string;
        offset?: number;
        limit?: number;
      };

      if (!workspaceId || !path) {
        res.status(400).json({ error: "Missing workspaceId or path" });
        return;
      }

      const session = getSession(workspaceId);
      if (!session || session.status !== "ready") {
        res.status(404).json({ error: "Workspace not found or not ready" });
        return;
      }

      touchActivity(workspaceId);

      // SECURITY (W3): Validate path within /workspace/
      const safePath = validateWorkspacePath(path);
      const maxLines = Math.min(limit ?? MAX_FILE_READ_LINES, 5000);
      const startLine = Math.max(offset ?? 1, 1);

      // Use sed for line-range extraction (more reliable than head/tail combos)
      const cmd = `sed -n '${startLine},${startLine + maxLines - 1}p' '${safePath}' 2>/dev/null || echo '[file not found or binary]'`;
      const result = await session.vmHandle.exec(cmd, 30_000, "agent");

      // Check if file is binary
      const isBinaryCmd = `file --mime-encoding '${safePath}' 2>/dev/null | grep -q binary && echo binary || echo text`;
      const typeResult = await session.vmHandle.exec(isBinaryCmd, 5_000, "agent");
      const isBinary = typeResult.stdout.trim() === "binary";

      if (isBinary) {
        res.json({
          content: "[Binary file — cannot display]",
          isBinary: true,
          path: safePath,
        });
        return;
      }

      // Get total line count
      const wcResult = await session.vmHandle.exec(
        `wc -l < '${safePath}' 2>/dev/null || echo 0`,
        5_000,
        "agent",
      );
      const totalLines = parseInt(wcResult.stdout.trim(), 10) || 0;

      res.json({
        content: result.stdout,
        path: safePath,
        totalLines,
        startLine,
        linesReturned: result.stdout.split("\n").length - 1,
        isBinary: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Read failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/write-file — Write file to dev VM
  // -------------------------------------------------------------------------
  router.post("/workspace/write-file", async (req: Request, res: Response) => {
    try {
      const { workspaceId, path, content } = req.body as {
        workspaceId: string;
        path: string;
        content: string;
      };

      if (!workspaceId || !path || content === undefined) {
        res.status(400).json({ error: "Missing workspaceId, path, or content" });
        return;
      }

      // SECURITY (W8): Reject files over 1MB
      if (Buffer.byteLength(content, "utf-8") > MAX_FILE_WRITE_BYTES) {
        res.status(400).json({
          error: `File too large (max ${MAX_FILE_WRITE_BYTES / 1024 / 1024}MB)`,
        });
        return;
      }

      const session = getSession(workspaceId);
      if (!session || session.status !== "ready") {
        res.status(404).json({ error: "Workspace not found or not ready" });
        return;
      }

      touchActivity(workspaceId);

      // SECURITY (W3): Validate path within /workspace/
      const safePath = validateWorkspacePath(path);

      // Write via vsock file_write
      const buf = Buffer.from(content, "utf-8");
      await session.vmHandle.writeFile!(safePath, buf, "0644", "agent:agent");

      res.json({
        bytesWritten: buf.length,
        path: safePath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Write failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/diff — Extract git diff from workspace
  // -------------------------------------------------------------------------
  router.post("/workspace/diff", async (req: Request, res: Response) => {
    try {
      const { workspaceId } = req.body as { workspaceId: string };
      if (!workspaceId) {
        res.status(400).json({ error: "Missing workspaceId" });
        return;
      }

      const session = getSession(workspaceId);
      if (!session || session.status !== "ready") {
        res.status(404).json({ error: "Workspace not found or not ready" });
        return;
      }

      touchActivity(workspaceId);

      const diff = await extractDiff(workspaceId);
      res.json(diff);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Diff extraction failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/status — Health check + metadata
  // -------------------------------------------------------------------------
  router.post("/workspace/status", async (req: Request, res: Response) => {
    try {
      const { workspaceId } = req.body as { workspaceId: string };
      if (!workspaceId) {
        res.status(400).json({ error: "Missing workspaceId" });
        return;
      }

      const session = getSession(workspaceId);
      if (!session) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }

      res.json({
        workspaceId: session.workspaceId,
        status: session.status,
        vmId: session.vmHandle?.vmId,
        language: session.language,
        createdAt: session.createdAt,
        readyAt: session.readyAt,
        expiresAt: session.expiresAt,
        lastActivityAt: session.lastActivityAt,
        errorMessage: session.errorMessage,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Status check failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/destroy — Tear down VM
  // -------------------------------------------------------------------------
  router.post("/workspace/destroy", async (req: Request, res: Response) => {
    try {
      const { workspaceId, reason } = req.body as {
        workspaceId: string;
        reason?: string;
      };
      if (!workspaceId) {
        res.status(400).json({ error: "Missing workspaceId" });
        return;
      }

      await destroyWorkspace(workspaceId, reason ?? "api_request");
      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Destroy failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/extend-ttl — Extend workspace TTL
  // -------------------------------------------------------------------------
  router.post("/workspace/extend-ttl", async (req: Request, res: Response) => {
    try {
      const { workspaceId, newExpiresAt } = req.body as {
        workspaceId: string;
        newExpiresAt: number;
      };
      if (!workspaceId || !newExpiresAt) {
        res.status(400).json({ error: "Missing workspaceId or newExpiresAt" });
        return;
      }

      extendTTL(workspaceId, newExpiresAt);
      res.json({ success: true, expiresAt: newExpiresAt });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Extend TTL failed";
      res.status(500).json({ error: message });
    }
  });

  return router;
}
