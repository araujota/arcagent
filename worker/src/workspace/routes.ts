/**
 * Express routes for workspace operations.
 *
 * Routes are authenticated via authMiddleware:
 * - Service bearer secret (WORKER_SHARED_SECRET), or
 * - Scoped short-lived workspace tokens minted by Convex.
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
import { isBlockedCommand, validateWorkspacePath, shellEscape, validateGlobPattern } from "./validation";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Output limits
// ---------------------------------------------------------------------------

const MAX_STDOUT = 200 * 1024; // 200 KB
const MAX_STDERR = 50 * 1024; // 50 KB
const MAX_FILE_READ_LINES = 2000;
const MAX_FILE_WRITE_BYTES = 1 * 1024 * 1024; // 1 MB
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const MAX_EXEC_TIMEOUT_MS = 300_000;

// Batch operation limits
const MAX_BATCH_FILES = 10;
const MAX_BATCH_LINES_PER_FILE = 1000;

// Search/list limits
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_PATTERN_LENGTH = 500;
const MAX_LIST_FILES_RESULTS = 500;
const MAX_LIST_FILES_DEPTH = 20;

// Streaming exec limits
const MAX_STREAM_JOBS_PER_SESSION = 3;
const STREAM_JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const STREAM_JOB_CLEANUP_MS = 5 * 60 * 1000; // remove finished job records after 5 min

// ---------------------------------------------------------------------------
// Streaming exec job tracking (per-session, not global)
// ---------------------------------------------------------------------------

interface StreamJob {
  jobId: string;
  pid: string;
  startedAt: number;
  timeoutMs: number;
  done: boolean;
  exitCode?: number;
}

// Map of workspaceId -> Map of jobId -> StreamJob
const streamJobs = new Map<string, Map<string, StreamJob>>();

function getStreamJobs(workspaceId: string): Map<string, StreamJob> {
  let jobs = streamJobs.get(workspaceId);
  if (!jobs) {
    jobs = new Map();
    streamJobs.set(workspaceId, jobs);
  }
  return jobs;
}

function cleanupStreamJobs(workspaceId: string): void {
  streamJobs.delete(workspaceId);
}

// isBlockedCommand and validateWorkspacePath imported from ./validation

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
        repoAuthToken,
        commitSha,
        language,
        expiresAt,
      } = req.body as {
        workspaceId: string;
        claimId: string;
        bountyId: string;
        agentId: string;
        repoUrl: string;
        repoAuthToken?: string;
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
        repoAuthToken,
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
      // Surface retry info for capacity errors
      const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
      if (retryAfterMs) {
        res.status(503).json({ error: message, retryAfterMs });
      } else {
        res.status(500).json({ error: message });
      }
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
      const endLine = startLine + maxLines - 1;

      // Single exec call: binary check + line count + content extraction
      // Returns JSON so we parse once instead of 3 sequential vsock round-trips
      const cmd = `f='${safePath}'; ` +
        `if [ ! -f "$f" ]; then printf '{"error":"not_found"}'; ` +
        `elif file --mime-encoding "$f" 2>/dev/null | grep -q binary; then printf '{"binary":true}'; ` +
        `else total=$(wc -l < "$f" 2>/dev/null || echo 0); ` +
        `content=$(sed -n '${startLine},${endLine}p' "$f" 2>/dev/null | base64 -w0 2>/dev/null || sed -n '${startLine},${endLine}p' "$f" 2>/dev/null | base64); ` +
        `printf '{"binary":false,"totalLines":%s,"content":"%s"}' "$total" "$content"; fi`;

      const result = await session.vmHandle.exec(cmd, 30_000, "agent");
      const raw = result.stdout.trim();

      let parsed: { error?: string; binary?: boolean; totalLines?: number; content?: string };
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Fallback if JSON parse fails (e.g., very large output)
        parsed = { error: "parse_failed" };
      }

      if (parsed.error === "not_found") {
        res.json({ content: "[file not found]", isBinary: false, path: safePath, totalLines: 0, startLine, linesReturned: 0 });
        return;
      }
      if (parsed.binary) {
        res.json({ content: "[Binary file — cannot display]", isBinary: true, path: safePath });
        return;
      }

      // Decode base64 content
      const decoded = parsed.content
        ? Buffer.from(parsed.content, "base64").toString("utf-8")
        : "";
      const totalLines = parsed.totalLines ?? 0;

      res.json({
        content: decoded,
        path: safePath,
        totalLines,
        startLine,
        linesReturned: decoded ? decoded.split("\n").length - 1 : 0,
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

  // -------------------------------------------------------------------------
  // POST /workspace/batch-read — Read multiple files in one request
  // -------------------------------------------------------------------------
  router.post("/workspace/batch-read", async (req: Request, res: Response) => {
    try {
      const { workspaceId, paths, maxLinesPerFile } = req.body as {
        workspaceId: string;
        paths: string[];
        maxLinesPerFile?: number;
      };

      if (!workspaceId || !Array.isArray(paths) || paths.length === 0) {
        res.status(400).json({ error: "Missing workspaceId or paths array" });
        return;
      }

      if (paths.length > MAX_BATCH_FILES) {
        res.status(400).json({ error: `Too many files (max ${MAX_BATCH_FILES})` });
        return;
      }

      const session = getSession(workspaceId);
      if (!session || session.status !== "ready") {
        res.status(404).json({ error: "Workspace not found or not ready" });
        return;
      }

      touchActivity(workspaceId);

      // SECURITY (W3): Validate every path individually — one bad path fails the whole batch
      const safePaths = paths.map((p: string) => validateWorkspacePath(p));
      const maxLines = Math.min(maxLinesPerFile ?? MAX_BATCH_LINES_PER_FILE, MAX_BATCH_LINES_PER_FILE);

      // Single exec call: shell script that reads all files in a loop, outputs JSON array
      const script = safePaths.map((sp, i) => {
        return `f='${sp}'; ` +
          `if [ ! -f "$f" ]; then printf '${i > 0 ? "," : ""}{"path":"%s","error":"not_found"}' "$f"; ` +
          `elif file --mime-encoding "$f" 2>/dev/null | grep -q binary; then printf '${i > 0 ? "," : ""}{"path":"%s","isBinary":true,"content":""}' "$f"; ` +
          `else total=$(wc -l < "$f" 2>/dev/null || echo 0); ` +
          `content=$(sed -n '1,${maxLines}p' "$f" 2>/dev/null | base64 -w0 2>/dev/null || sed -n '1,${maxLines}p' "$f" 2>/dev/null | base64); ` +
          `printf '${i > 0 ? "," : ""}{"path":"%s","isBinary":false,"totalLines":%s,"content":"%s"}' "$f" "$total" "$content"; fi`;
      }).join("; ");

      const cmd = `printf '['; ${script}; printf ']'`;
      const result = await session.vmHandle.exec(cmd, 60_000, "agent");

      let files: Array<{
        path: string;
        content?: string;
        totalLines?: number;
        isBinary?: boolean;
        error?: string;
      }>;

      try {
        files = JSON.parse(result.stdout.trim());
      } catch {
        res.status(500).json({ error: "Failed to parse batch read output" });
        return;
      }

      // Decode base64 content for non-binary files
      const decoded = files.map((f) => {
        if (f.isBinary || f.error) return f;
        return {
          ...f,
          content: f.content ? Buffer.from(f.content, "base64").toString("utf-8") : "",
        };
      });

      res.json({ files: decoded });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Batch read failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/batch-write — Write multiple files in one request
  // -------------------------------------------------------------------------
  router.post("/workspace/batch-write", async (req: Request, res: Response) => {
    try {
      const { workspaceId, files } = req.body as {
        workspaceId: string;
        files: Array<{ path: string; content: string }>;
      };

      if (!workspaceId || !Array.isArray(files) || files.length === 0) {
        res.status(400).json({ error: "Missing workspaceId or files array" });
        return;
      }

      if (files.length > MAX_BATCH_FILES) {
        res.status(400).json({ error: `Too many files (max ${MAX_BATCH_FILES})` });
        return;
      }

      // Check total content size
      const totalBytes = files.reduce(
        (acc, f) => acc + Buffer.byteLength(f.content ?? "", "utf-8"),
        0,
      );
      if (totalBytes > MAX_FILE_WRITE_BYTES) {
        res.status(400).json({
          error: `Total content too large (${(totalBytes / 1024).toFixed(0)}KB > ${MAX_FILE_WRITE_BYTES / 1024}KB max)`,
        });
        return;
      }

      const session = getSession(workspaceId);
      if (!session || session.status !== "ready") {
        res.status(404).json({ error: "Workspace not found or not ready" });
        return;
      }

      touchActivity(workspaceId);

      // SECURITY (W3): Validate every path individually
      const safeFiles = files.map((f) => ({
        path: validateWorkspacePath(f.path),
        content: f.content,
      }));

      // Write files sequentially via vsockWriteFile (can't parallelize per-connection)
      const results: Array<{ path: string; bytesWritten: number; error?: string }> = [];

      for (const f of safeFiles) {
        try {
          const buf = Buffer.from(f.content, "utf-8");
          await session.vmHandle.writeFile!(f.path, buf, "0644", "agent:agent");
          results.push({ path: f.path, bytesWritten: buf.length });
        } catch (writeErr) {
          results.push({
            path: f.path,
            bytesWritten: 0,
            error: writeErr instanceof Error ? writeErr.message : "Write failed",
          });
        }
      }

      res.json({ results });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Batch write failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/search — Structured grep inside workspace
  // -------------------------------------------------------------------------
  router.post("/workspace/search", async (req: Request, res: Response) => {
    try {
      const { workspaceId, pattern, glob, maxResults, caseSensitive } = req.body as {
        workspaceId: string;
        pattern: string;
        glob?: string;
        maxResults?: number;
        caseSensitive?: boolean;
      };

      if (!workspaceId || !pattern) {
        res.status(400).json({ error: "Missing workspaceId or pattern" });
        return;
      }

      if (pattern.length > MAX_SEARCH_PATTERN_LENGTH) {
        res.status(400).json({ error: `Pattern too long (max ${MAX_SEARCH_PATTERN_LENGTH} chars)` });
        return;
      }

      const session = getSession(workspaceId);
      if (!session || session.status !== "ready") {
        res.status(404).json({ error: "Workspace not found or not ready" });
        return;
      }

      touchActivity(workspaceId);

      const max = Math.min(maxResults ?? 100, MAX_SEARCH_RESULTS);

      // SECURITY (W9): Shell-safe pattern escaping
      const escapedPattern = shellEscape(pattern);

      // SECURITY (W9): Validate glob against strict allowlist
      let globArg = "";
      if (glob) {
        validateGlobPattern(glob);
        globArg = `--include=${shellEscape(glob)}`;
      }

      const caseFlag = caseSensitive === false ? "-i" : "";

      // Use -- separator to prevent flag injection from pattern
      const cmd = `grep -rn ${caseFlag} ${globArg} -m ${max} -B1 -A1 -- ${escapedPattern} /workspace/ 2>/dev/null || true`;
      const result = await session.vmHandle.exec(cmd, 30_000, "agent");

      // Parse grep output into structured results
      const matches: Array<{
        file: string;
        line: number;
        text: string;
      }> = [];

      const lines = result.stdout.split("\n");
      for (const line of lines) {
        // grep -n format: file:line:text or file-line-text (for context lines)
        const match = line.match(/^(.+?):(\d+)[:|-](.*)$/);
        if (match) {
          const filePath = match[1].replace(/^\/workspace\//, "");
          matches.push({
            file: filePath,
            line: parseInt(match[2], 10),
            text: match[3],
          });
        }
      }

      res.json({
        matches,
        totalMatches: matches.length,
        truncated: matches.length >= max,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Search failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/list-files — List files with optional glob
  // -------------------------------------------------------------------------
  router.post("/workspace/list-files", async (req: Request, res: Response) => {
    try {
      const { workspaceId, glob, maxDepth, maxResults } = req.body as {
        workspaceId: string;
        glob?: string;
        maxDepth?: number;
        maxResults?: number;
      };

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

      const depth = Math.min(maxDepth ?? 10, MAX_LIST_FILES_DEPTH);
      const max = Math.min(maxResults ?? MAX_LIST_FILES_RESULTS, MAX_LIST_FILES_RESULTS);

      // SECURITY (W9): Validate glob against strict allowlist
      let nameArg = "";
      if (glob) {
        validateGlobPattern(glob);
        nameArg = `-name ${shellEscape(glob)}`;
      }

      // Exclude .git and node_modules for cleaner results
      const cmd = `find /workspace -maxdepth ${depth} ${nameArg} -type f ` +
        `-not -path '*/\\.git/*' -not -path '*/node_modules/*' 2>/dev/null | head -${max + 1}`;
      const result = await session.vmHandle.exec(cmd, 30_000, "agent");

      const allFiles = result.stdout.trim().split("\n").filter(Boolean);
      const truncated = allFiles.length > max;
      const files = allFiles.slice(0, max).map((f) => f.replace(/^\/workspace\//, ""));

      res.json({
        files,
        totalCount: files.length,
        truncated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "List files failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/exec-stream — Start a long-running command (returns jobId)
  // -------------------------------------------------------------------------
  router.post("/workspace/exec-stream", async (req: Request, res: Response) => {
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

      // Check concurrent job limit
      const jobs = getStreamJobs(workspaceId);
      const activeJobs = Array.from(jobs.values()).filter((j) => !j.done);
      if (activeJobs.length >= MAX_STREAM_JOBS_PER_SESSION) {
        res.status(429).json({
          error: `Too many concurrent streaming jobs (max ${MAX_STREAM_JOBS_PER_SESSION})`,
        });
        return;
      }

      const jobId = crypto.randomUUID();
      const timeout = Math.min(timeoutMs ?? STREAM_JOB_TIMEOUT_MS, STREAM_JOB_TIMEOUT_MS);

      // Start command as background process in VM, redirect output to temp files
      // SECURITY (W2): Commands always run as non-root "agent" user
      const startCmd =
        `nohup sh -c ${shellEscape(`${command} > /tmp/exec-${jobId}.out 2> /tmp/exec-${jobId}.err; echo $? > /tmp/exec-${jobId}.rc`)} ` +
        `> /dev/null 2>&1 & echo $!`;

      const startResult = await session.vmHandle.exec(startCmd, 10_000, "agent");
      const pid = startResult.stdout.trim();

      const job: StreamJob = {
        jobId,
        pid,
        startedAt: Date.now(),
        timeoutMs: timeout,
        done: false,
      };
      jobs.set(jobId, job);

      // Schedule timeout kill
      setTimeout(async () => {
        const j = jobs.get(jobId);
        if (j && !j.done) {
          j.done = true;
          j.exitCode = 137; // SIGKILL
          // Kill the process in the VM
          try {
            const s = getSession(workspaceId);
            if (s && s.status === "ready") {
              await s.vmHandle.exec(`kill -9 ${pid} 2>/dev/null || true`, 5_000, "agent");
            }
          } catch { /* ignore */ }
        }
      }, timeout);

      // Schedule cleanup of job record after timeout + cleanup window
      setTimeout(() => {
        jobs.delete(jobId);
        // Clean up temp files
        const s = getSession(workspaceId);
        if (s && s.status === "ready") {
          s.vmHandle.exec(
            `rm -f /tmp/exec-${jobId}.out /tmp/exec-${jobId}.err /tmp/exec-${jobId}.rc`,
            5_000,
            "agent",
          ).catch(() => {});
        }
      }, timeout + STREAM_JOB_CLEANUP_MS);

      res.json({ jobId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Exec stream start failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/exec-output — Poll output from a streaming exec job
  // -------------------------------------------------------------------------
  router.post("/workspace/exec-output", async (req: Request, res: Response) => {
    try {
      const { workspaceId, jobId, offset } = req.body as {
        workspaceId: string;
        jobId: string;
        offset?: number;
      };

      if (!workspaceId || !jobId) {
        res.status(400).json({ error: "Missing workspaceId or jobId" });
        return;
      }

      const session = getSession(workspaceId);
      if (!session || session.status !== "ready") {
        res.status(404).json({ error: "Workspace not found or not ready" });
        return;
      }

      // SECURITY: Job lookup scoped to this workspace's session
      const jobs = getStreamJobs(workspaceId);
      const job = jobs.get(jobId);
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      touchActivity(workspaceId);

      const byteOffset = Math.max(offset ?? 0, 0);

      // Read stdout from offset
      const outCmd = byteOffset > 0
        ? `tail -c +${byteOffset + 1} /tmp/exec-${jobId}.out 2>/dev/null || true`
        : `cat /tmp/exec-${jobId}.out 2>/dev/null || true`;
      const outResult = await session.vmHandle.exec(outCmd, 10_000, "agent");

      // Read stderr
      const errCmd = `cat /tmp/exec-${jobId}.err 2>/dev/null || true`;
      const errResult = await session.vmHandle.exec(errCmd, 10_000, "agent");

      // Check if done
      const rcCmd = `test -f /tmp/exec-${jobId}.rc && cat /tmp/exec-${jobId}.rc || echo RUNNING`;
      const rcResult = await session.vmHandle.exec(rcCmd, 5_000, "agent");
      const rcStr = rcResult.stdout.trim();

      let done = false;
      let exitCode: number | undefined;

      if (rcStr !== "RUNNING") {
        done = true;
        exitCode = parseInt(rcStr, 10);
        if (isNaN(exitCode)) exitCode = 1;
        job.done = true;
        job.exitCode = exitCode;
      }

      // Calculate new offset (current offset + bytes returned)
      const newOffset = byteOffset + Buffer.byteLength(outResult.stdout, "utf-8");

      res.json({
        stdout: truncate(outResult.stdout, MAX_STDOUT),
        stderr: truncate(errResult.stdout, MAX_STDERR),
        done,
        exitCode,
        offset: newOffset,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Exec output poll failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/edit-file — Surgical string replacement in a file
  // -------------------------------------------------------------------------
  router.post("/workspace/edit-file", async (req: Request, res: Response) => {
    try {
      const { workspaceId, path, oldString, newString, replaceAll } = req.body as {
        workspaceId: string;
        path: string;
        oldString: string;
        newString: string;
        replaceAll?: boolean;
      };

      if (!workspaceId || !path || oldString === undefined || newString === undefined) {
        res.status(400).json({ error: "Missing workspaceId, path, oldString, or newString" });
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

      // Send file_edit request via vsock — edit happens entirely inside the VM
      const vsockResult = await session.vmHandle.vsockRequest!({
        type: "file_edit",
        path: safePath,
        oldString,
        newString,
        replaceAll: replaceAll ?? false,
      });

      if (vsockResult.error) {
        if (vsockResult.error === "not_found") {
          res.status(400).json({
            error: "old_string not found in file",
            path: safePath,
            replacements: 0,
          });
          return;
        }
        if (vsockResult.error === "ambiguous") {
          res.status(400).json({
            error: "old_string matches multiple locations — provide more context or set replaceAll=true",
            path: safePath,
            replacements: 0,
          });
          return;
        }
        res.status(500).json({ error: vsockResult.error, path: safePath });
        return;
      }

      res.json({
        path: safePath,
        replacements: vsockResult.replacements ?? 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Edit failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/glob — Glob pattern file search
  // -------------------------------------------------------------------------
  router.post("/workspace/glob", async (req: Request, res: Response) => {
    try {
      const { workspaceId, pattern, path, maxResults } = req.body as {
        workspaceId: string;
        pattern: string;
        path?: string;
        maxResults?: number;
      };

      if (!workspaceId || !pattern) {
        res.status(400).json({ error: "Missing workspaceId or pattern" });
        return;
      }

      const session = getSession(workspaceId);
      if (!session || session.status !== "ready") {
        res.status(404).json({ error: "Workspace not found or not ready" });
        return;
      }

      touchActivity(workspaceId);

      const max = Math.min(maxResults ?? 500, MAX_LIST_FILES_RESULTS);
      const searchPath = path ? validateWorkspacePath(path) : "/workspace";

      // Send file_glob request via vsock
      const vsockResult = await session.vmHandle.vsockRequest!({
        type: "file_glob",
        pattern,
        path: searchPath,
        maxResults: max,
      });

      res.json({
        files: vsockResult.files ?? [],
        totalMatches: vsockResult.totalMatches ?? 0,
        truncated: vsockResult.truncated ?? false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Glob search failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/grep — Ripgrep-powered content search
  // -------------------------------------------------------------------------
  router.post("/workspace/grep", async (req: Request, res: Response) => {
    try {
      const { workspaceId, pattern, path, glob, caseSensitive, maxResults, contextLines, outputMode } = req.body as {
        workspaceId: string;
        pattern: string;
        path?: string;
        glob?: string;
        caseSensitive?: boolean;
        maxResults?: number;
        contextLines?: number;
        outputMode?: "content" | "files_with_matches" | "count";
      };

      if (!workspaceId || !pattern) {
        res.status(400).json({ error: "Missing workspaceId or pattern" });
        return;
      }

      if (pattern.length > MAX_SEARCH_PATTERN_LENGTH) {
        res.status(400).json({ error: `Pattern too long (max ${MAX_SEARCH_PATTERN_LENGTH} chars)` });
        return;
      }

      const session = getSession(workspaceId);
      if (!session || session.status !== "ready") {
        res.status(404).json({ error: "Workspace not found or not ready" });
        return;
      }

      touchActivity(workspaceId);

      const max = Math.min(maxResults ?? 200, MAX_SEARCH_RESULTS);
      const searchPath = path ? validateWorkspacePath(path) : "/workspace";

      // Validate glob if provided
      if (glob) {
        validateGlobPattern(glob);
      }

      // Send file_grep request via vsock
      const vsockResult = await session.vmHandle.vsockRequest!({
        type: "file_grep",
        pattern,
        path: searchPath,
        glob,
        caseSensitive: caseSensitive ?? true,
        maxResults: max,
        contextLines: contextLines ?? 0,
        outputMode: outputMode ?? "content",
      });

      res.json({
        matches: vsockResult.matches ?? [],
        totalMatches: vsockResult.totalMatches ?? 0,
        truncated: vsockResult.truncated ?? false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Grep search failed";
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /workspace/session-exec — Execute in persistent PTY shell session
  // -------------------------------------------------------------------------
  router.post("/workspace/session-exec", async (req: Request, res: Response) => {
    try {
      const { workspaceId, command, sessionId, timeoutMs } = req.body as {
        workspaceId: string;
        command: string;
        sessionId?: string;
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

      const sid = sessionId ?? session.defaultSessionId ?? "default";
      const timeout = Math.min(
        timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
        MAX_EXEC_TIMEOUT_MS,
      );

      // Send session_exec request via vsock
      const vsockResult = await session.vmHandle.vsockRequest!({
        type: "session_exec",
        sessionId: sid,
        command,
        timeoutMs: timeout,
      });

      if (vsockResult.error) {
        // Session not found — auto-create it
        if (vsockResult.error === "session_not_found") {
          await session.vmHandle.vsockRequest!({
            type: "session_create",
            sessionId: sid,
            shell: "/bin/bash",
            env: { HOME: "/home/agent", TERM: "xterm-256color" },
          });
          // Retry the command
          const retryResult = await session.vmHandle.vsockRequest!({
            type: "session_exec",
            sessionId: sid,
            command,
            timeoutMs: timeout,
          });
          res.json({
            stdout: truncate(retryResult.stdout ?? "", MAX_STDOUT),
            stderr: truncate(retryResult.stderr ?? "", MAX_STDERR),
            exitCode: retryResult.exitCode ?? 0,
            cwd: retryResult.cwd ?? "/workspace",
            sessionId: sid,
          });
          return;
        }
        res.status(500).json({ error: vsockResult.error });
        return;
      }

      res.json({
        stdout: truncate(vsockResult.stdout ?? "", MAX_STDOUT),
        stderr: truncate(vsockResult.stderr ?? "", MAX_STDERR),
        exitCode: vsockResult.exitCode ?? 0,
        cwd: vsockResult.cwd ?? "/workspace",
        sessionId: sid,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Shell exec failed";
      res.status(500).json({ error: message });
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Cleanup helper — called from destroyWorkspace
// ---------------------------------------------------------------------------

/**
 * Clean up all streaming exec job temp files for a workspace.
 * Call this when destroying a workspace session.
 */
export { cleanupStreamJobs };
