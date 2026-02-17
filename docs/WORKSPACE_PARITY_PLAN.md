# Workspace Feature Parity Implementation Plan

> **Goal**: Bring the dev workspace VM environment to full feature parity with Claude Code / Codex / Devin, so any breed of AI agent can work inside a Firecracker VM with the same fluency they have on a local machine — while maintaining zero code exfiltration.

---

## Table of Contents

1. [Component 1: vsock-agent (Go binary)](#component-1-vsock-agent-go-binary)
2. [Component 2: Persistent Shell Sessions](#component-2-persistent-shell-sessions)
3. [Component 3: Surgical Edit Tool](#component-3-surgical-edit-tool)
4. [Component 4: Enhanced File Operations (Glob + Grep)](#component-4-enhanced-file-operations)
5. [Component 5: Session Persistence & Crash Recovery](#component-5-session-persistence--crash-recovery)
6. [Component 6: Crash Reports in Convex](#component-6-crash-reports-in-convex)
7. [Component 7: Agent-Breed Abstraction Layer](#component-7-agent-breed-abstraction-layer)
8. [Component 8: Rootfs Build Pipeline](#component-8-rootfs-build-pipeline)
9. [Component 9: Dependency Caching via Snapshots](#component-9-dependency-caching-via-snapshots)
10. [Security Analysis](#security-analysis)
11. [Migration Plan](#migration-plan)
12. [Testing Strategy](#testing-strategy)

---

## Component 1: vsock-agent (Go binary)

### Problem
The `vsock-agent` binary is `COPY`'d into the rootfs Dockerfile (`worker/rootfs/base.Dockerfile:51`) but has **no source code in the repository**. The rootfs images cannot be built from this repo alone.

### Solution
Write the vsock-agent in Go (small static binary, no libc dependency, compiles to a single file ideal for Alpine). It will implement all current request types plus the new ones added by Components 2-4.

### New files
```
worker/vsock-agent/
├── main.go                 # Entry point: listen on vsock port 5000
├── protocol.go             # Length-prefixed JSON framing (matches vsockChannel.ts)
├── handler_exec.go         # exec / exec_with_stdin handlers
├── handler_file.go         # file_read / file_write handlers
├── handler_edit.go         # file_edit handler (Component 3)
├── handler_glob.go         # file_glob handler (Component 4)
├── handler_grep.go         # file_grep handler (Component 4)
├── handler_session.go      # session_create/exec/resize/destroy (Component 2)
├── handler_heartbeat.go    # heartbeat response for crash detection (Component 5)
├── sandbox.go              # Path validation, user switching, blocked commands
├── go.mod
├── go.sum
└── Makefile                # Cross-compile for linux/amd64, output to worker/rootfs/
```

### Protocol specification

The vsock-agent speaks the existing length-prefixed JSON protocol (`vsockChannel.ts:7-9`). New request types are added alongside existing ones:

```typescript
// Existing types (preserved exactly)
type: "exec" | "exec_with_stdin" | "file_write" | "file_read"

// New types (Components 2-4)
type: "file_edit"         // surgical string replacement
    | "file_glob"         // glob pattern file search
    | "file_grep"         // ripgrep-powered content search
    | "session_create"    // create persistent PTY shell
    | "session_exec"      // send command to existing PTY
    | "session_resize"    // resize PTY dimensions
    | "session_destroy"   // destroy PTY session
    | "heartbeat"         // liveness check (returns uptime, session count)
```

### Build integration
- `Makefile` target: `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o ../rootfs/vsock-agent ./`
- Binary lands at `worker/rootfs/vsock-agent` — exactly where `base.Dockerfile` expects it
- CI step: `cd worker/vsock-agent && make` before rootfs Docker build

### Security constraints
- All `exec` and `session_exec` commands run as the `agent` user (uid 1000) by default
- Root-user execution requires explicit `user: "root"` in the request (only used by host for setup commands like `chown`, injecting step definitions)
- Path validation: all `file_*` operations validate that resolved paths are within `/workspace/` (symlink-aware, using `filepath.EvalSymlinks`)
- Blocked command patterns: `poweroff`, `shutdown`, `reboot`, `halt`, `init`, `rm -rf /`, `dd if=.* of=/dev/`

---

## Component 2: Persistent Shell Sessions

### Problem
Every `workspace_exec` call creates a new shell. No working directory persistence, no env var persistence, no background processes. This is the **single biggest gap** versus Claude Code (which persists cwd across Bash calls) and Devin (which has a full persistent VM terminal).

### Design

#### In-guest: PTY session manager (in vsock-agent)

The vsock-agent manages a pool of named PTY sessions inside the VM:

```go
type ShellSession struct {
    ID        string
    PTY       *os.File        // master side of PTY
    Cmd       *exec.Cmd       // bash -l process
    Cwd       string          // tracked from PS1 hook
    CreatedAt time.Time
    LastUsed  time.Time
}
```

**Lifecycle**:
1. `session_create` → forks `bash -l` with a PTY, sets `PS1` hook to emit CWD after each command, returns `sessionId`
2. `session_exec` → writes command + newline to PTY master, reads output until prompt delimiter, returns `{stdout, cwd, exitCode}`
3. `session_resize` → `ioctl(TIOCSWINSZ)` on the PTY fd
4. `session_destroy` → `SIGHUP` to bash, close PTY

**Output demarcation**: The PTY bash process is configured with a custom `PROMPT_COMMAND` that emits a unique delimiter after each command:

```bash
# Injected into .bashrc at session_create time
__arc_delim() {
  local ec=$?
  printf '\x1e__ARC_DONE__%d__%s__\x1e\n' "$ec" "$PWD"
}
PROMPT_COMMAND='__arc_delim'
```

The vsock-agent reads PTY output, buffering until it sees the `__ARC_DONE__` marker, then extracts exit code and cwd from the delimiter.

**Session limits**:
- Max 4 concurrent sessions per VM (prevent fork bombs via too many PTYs)
- Sessions idle >30 minutes are auto-destroyed
- Sessions auto-destroyed when VM is torn down

#### On-host: vsockChannel.ts extensions

```typescript
// New request/response types added to VsockRequest/VsockResponse

// Request additions:
interface VsockRequest {
  // ... existing fields ...
  type: "exec" | "exec_with_stdin" | "file_write" | "file_read"
      | "session_create" | "session_exec" | "session_resize" | "session_destroy"
      | "file_edit" | "file_glob" | "file_grep" | "heartbeat";

  // session_create fields:
  sessionId?: string;       // optional client-chosen ID
  shell?: string;           // default: "/bin/bash"
  env?: Record<string, string>; // initial environment variables
  rows?: number;            // PTY rows (default 24)
  cols?: number;            // PTY cols (default 80)

  // session_exec fields:
  // sessionId (required), command (required), timeoutMs (optional)

  // session_resize fields:
  // sessionId (required), rows (required), cols (required)
}

// Response additions:
interface VsockResponse {
  // ... existing fields ...
  sessionId?: string;       // for session_create response
  cwd?: string;             // current working directory after session_exec
}
```

#### Worker: sessionManager.ts extensions

The `WorkspaceSession` type gains a `defaultSessionId` field:

```typescript
interface WorkspaceSession {
  // ... existing fields ...
  defaultSessionId?: string;  // PTY session created at provision time
}
```

At provision time (after `installDependencies`), the worker auto-creates a default PTY session:
```typescript
const sessionResult = await vm.exec(JSON.stringify({
  type: "session_create",
  sessionId: "default",
  env: { HOME: "/home/agent", TERM: "xterm-256color" }
}));
session.defaultSessionId = "default";
```

#### Worker: new API endpoint

```
POST /api/workspace/session-exec
  body: { workspaceId, command, sessionId?, timeoutMs? }
  response: { stdout, stderr, exitCode, cwd, sessionId }
```

Falls back to `sessionId: "default"` if not specified. The worker forwards to the vsock-agent via the `session_exec` request type.

#### MCP: new tool `workspace_shell`

```typescript
// mcp-server/src/tools/workspaceShell.ts
registerTool(server, "workspace_shell",
  "Execute a command in a persistent shell session. Working directory and " +
  "environment variables persist between calls. The repo is at /workspace.",
  {
    bountyId: z.string(),
    command: z.string(),
    sessionId: z.string().optional()
      .describe("Shell session ID (default: 'default')"),
  },
  async (args) => { /* call POST /api/workspace/session-exec */ }
);
```

The existing `workspace_exec` remains for backwards compatibility (stateless one-shot commands). The new `workspace_shell` becomes the recommended tool.

#### Non-exfiltration guarantee

PTY sessions run inside the VM as the `agent` user. All I/O flows through the vsock channel to the worker process. The agent (MCP client) never gets a raw socket or SSH connection — only structured JSON responses. The egress filtering on the TAP device remains in effect, blocking GitHub domains post-clone.

---

## Component 3: Surgical Edit Tool

### Problem
Agents must read an entire file, modify it in-memory, and write the whole thing back via `workspace_write_file`. This wastes tokens, is error-prone for large files, and diverges from every major agent platform's approach.

### Design

The edit operation runs **entirely inside the VM** via the vsock-agent. File contents never cross the vsock boundary for the edit — only the `old_string` and `new_string` travel over the wire.

#### vsock request type: `file_edit`

```typescript
interface VsockRequest {
  type: "file_edit";
  path: string;                // absolute path (validated to /workspace/)
  oldString: string;           // exact text to find
  newString: string;           // replacement text
  replaceAll?: boolean;        // replace all occurrences (default: false)
  user?: string;               // default: "agent"
}

// Response:
interface VsockResponse {
  type: "file_result";
  replacements: number;        // how many replacements were made
  error?: string;              // "not_found" | "ambiguous" (multiple matches, replaceAll=false)
}
```

#### In-guest implementation (handler_edit.go)

```go
func handleFileEdit(req Request) Response {
    // 1. Validate path resolves within /workspace/
    absPath, err := validateWorkspacePath(req.Path)
    if err != nil {
        return errorResponse("path_invalid", err.Error())
    }

    // 2. Read file
    content, err := os.ReadFile(absPath)
    if err != nil {
        return errorResponse("read_failed", err.Error())
    }

    text := string(content)
    count := strings.Count(text, req.OldString)

    // 3. Validate match uniqueness
    if count == 0 {
        return Response{Type: "file_result", Error: "not_found", Replacements: 0}
    }
    if count > 1 && !req.ReplaceAll {
        return Response{Type: "file_result", Error: "ambiguous", Replacements: 0}
    }

    // 4. Replace
    var newText string
    if req.ReplaceAll {
        newText = strings.ReplaceAll(text, req.OldString, req.NewString)
    } else {
        newText = strings.Replace(text, req.OldString, req.NewString, 1)
    }

    // 5. Write back (atomic: write to temp + rename)
    tmpPath := absPath + ".arc-tmp"
    if err := os.WriteFile(tmpPath, []byte(newText), info.Mode()); err != nil {
        return errorResponse("write_failed", err.Error())
    }
    if err := os.Rename(tmpPath, absPath); err != nil {
        return errorResponse("rename_failed", err.Error())
    }

    return Response{Type: "file_result", Replacements: count}
}
```

#### Non-exfiltration guarantee

The file content is read and written **entirely inside the VM**. Only the edit instructions (`oldString`, `newString`) cross the vsock boundary. This is actually more secure than the current `workspace_write_file`, which sends the entire file content from the MCP server through the worker into the VM.

#### Worker endpoint

```
POST /api/workspace/edit-file
  body: { workspaceId, path, oldString, newString, replaceAll? }
  response: { path, replacements }
```

#### MCP tool: `workspace_edit_file`

```typescript
// mcp-server/src/tools/workspaceEditFile.ts
registerTool(server, "workspace_edit_file",
  "Make a surgical text replacement in a file. Finds the exact old_string and " +
  "replaces it with new_string. Fails if old_string is not found or matches " +
  "multiple locations (unless replace_all is true). Much more efficient than " +
  "reading and rewriting the entire file.",
  {
    bountyId: z.string(),
    path: z.string().describe("File path relative to /workspace"),
    oldString: z.string().describe("Exact text to find and replace"),
    newString: z.string().describe("Replacement text"),
    replaceAll: z.string().optional()
      .describe("Replace all occurrences: 'true' or 'false' (default 'false')"),
  },
  async (args) => { /* call POST /api/workspace/edit-file */ }
);
```

This matches Claude Code's `Edit` tool interface exactly.

---

## Component 4: Enhanced File Operations

### Problem
No dedicated glob search or structured grep. Agents must shell out to `find` and `grep`, parse raw output, and handle edge cases (spaces in filenames, binary files, etc.).

### 4a: file_glob

#### vsock request type

```typescript
interface VsockRequest {
  type: "file_glob";
  pattern: string;       // e.g., "**/*.ts", "src/**/*.test.js"
  path?: string;         // root directory (default: "/workspace")
  maxResults?: number;   // default: 500
}

interface VsockResponse {
  type: "file_result";
  files: string[];       // relative paths, sorted by mtime (newest first)
  totalMatches: number;
  truncated: boolean;
}
```

#### In-guest implementation (handler_glob.go)

Uses Go's `doublestar` library (`github.com/bmatcuk/doublestar/v4`) for proper `**` glob support. Results sorted by `ModTime` descending (matches Claude Code's Glob behavior).

Path validation: `pattern` is resolved relative to `/workspace/` and cannot escape it.

#### MCP tool: `workspace_glob`

```typescript
registerTool(server, "workspace_glob",
  "Find files by glob pattern. Supports ** for recursive matching. " +
  "Returns paths sorted by modification time (newest first).",
  {
    bountyId: z.string(),
    pattern: z.string().describe("Glob pattern (e.g., '**/*.ts', 'src/**/*.test.js')"),
    path: z.string().optional().describe("Root directory relative to /workspace (default: '.')"),
  },
  async (args) => { /* ... */ }
);
```

### 4b: file_grep (ripgrep-powered)

#### vsock request type

```typescript
interface VsockRequest {
  type: "file_grep";
  pattern: string;           // regex pattern
  path?: string;             // directory to search (default: "/workspace")
  glob?: string;             // file filter (e.g., "*.ts")
  caseSensitive?: boolean;   // default: true
  maxResults?: number;       // default: 200
  contextLines?: number;     // lines before/after match (default: 0)
  outputMode?: "content" | "files_with_matches" | "count";
}

interface VsockResponse {
  type: "file_result";
  matches: Array<{
    file: string;
    line: number;
    text: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }>;
  totalMatches: number;
  truncated: boolean;
}
```

#### In-guest implementation

Option A: Install `ripgrep` in the base rootfs image (adds ~5MB) and shell out to `rg --json`.
Option B: Use Go's `regexp` package with a custom directory walker.

**Recommendation**: Option A. ripgrep is battle-tested, handles binary files, .gitignore, and Unicode correctly. The JSON output mode (`rg --json`) gives structured results without parsing.

Add to `base.Dockerfile`:
```dockerfile
RUN apk add --no-cache ripgrep
```

#### MCP tool: `workspace_grep`

Replaces the existing `workspace_search` (which calls `grep` via `workspace_exec`) with a structured implementation:

```typescript
registerTool(server, "workspace_grep",
  "Search file contents using regex patterns. Powered by ripgrep. " +
  "Faster and more reliable than workspace_search.",
  {
    bountyId: z.string(),
    pattern: z.string().describe("Regex search pattern"),
    glob: z.string().optional().describe("File glob filter (e.g., '*.ts')"),
    path: z.string().optional().describe("Directory to search (default: '.')"),
    caseSensitive: z.string().optional().describe("'true' or 'false' (default: 'true')"),
    contextLines: z.string().optional().describe("Lines of context around matches (default: 0)"),
    outputMode: z.string().optional()
      .describe("'content' (default), 'files_with_matches', or 'count'"),
  },
  async (args) => { /* ... */ }
);
```

The old `workspace_search` remains as an alias for backwards compatibility.

---

## Component 5: Session Persistence & Crash Recovery

### Problem
All workspace sessions live in a Node.js `Map` in `sessionManager.ts:76`. Worker restart = all sessions lost. The `cleanupOrphanedWorkspaces()` function is a no-op.

### Design: Three-tier state management

```
┌─────────────────────────────────────────────────────┐
│ Tier 1: Redis (hot state, sub-ms reads)             │
│   - Session metadata + VM process info              │
│   - Heartbeat timestamps                            │
│   - Used by worker for all runtime lookups          │
├─────────────────────────────────────────────────────┤
│ Tier 2: Convex (durable state, authoritative)       │
│   - devWorkspaces table (already exists)            │
│   - Extended with vmId, vsockPath, process metadata │
│   - Crash reports table (Component 6)               │
│   - Used for cross-restart recovery                 │
├─────────────────────────────────────────────────────┤
│ Tier 3: Firecracker VM (actual compute)             │
│   - VM process survives worker restart              │
│   - vsock-agent keeps running                       │
│   - PTY sessions preserved in-guest                 │
└─────────────────────────────────────────────────────┘
```

### 5a: Redis session store

Replace the in-memory `Map` with a Redis-backed store. Each session is stored as a Redis hash:

```typescript
// worker/src/workspace/sessionStore.ts

interface SessionRecord {
  workspaceId: string;
  vmId: string;
  vsockSocketPath: string;
  tapDevice: string;
  overlayPath: string;
  claimId: string;
  bountyId: string;
  agentId: string;
  language: string;
  baseRepoUrl: string;
  baseCommitSha: string;
  status: "provisioning" | "ready" | "error" | "destroyed";
  createdAt: number;
  readyAt?: number;
  expiresAt: number;
  lastActivityAt: number;
  lastHeartbeatAt: number;
  firecrackerPid: number;
  workerInstanceId: string;  // identifies which worker process owns this
  defaultSessionId?: string;
}

// Key scheme:
//   workspace:{workspaceId}        → SessionRecord hash
//   workspace:by-agent:{agentId}   → Set of workspaceIds
//   worker:heartbeat:{instanceId}  → timestamp (TTL 30s)
```

Redis is already a dependency (BullMQ). No new infrastructure needed.

### 5b: Worker startup recovery

On worker startup:

```typescript
// worker/src/workspace/recovery.ts

async function recoverOrphanedSessions(): Promise<void> {
  const instanceId = generateInstanceId(); // random UUID per process

  // 1. Find all sessions in Redis that belong to a dead worker
  const allSessions = await redis.keys("workspace:*");
  for (const key of allSessions) {
    const session = await redis.hgetall(key);
    const ownerAlive = await redis.exists(`worker:heartbeat:${session.workerInstanceId}`);

    if (!ownerAlive && session.status === "ready") {
      // 2. Check if the Firecracker process is still running
      const vmAlive = isProcessAlive(parseInt(session.firecrackerPid));

      if (vmAlive) {
        // 3. Try to reconnect via vsock
        try {
          await waitForVsock(session.vsockSocketPath, session.vmId, 3, 500);
          // VM is alive and responsive — adopt this session
          await redis.hset(key, "workerInstanceId", instanceId);
          logger.info("Recovered orphaned workspace", { workspaceId: session.workspaceId });
          // Re-create in-memory VMHandle
          adoptSession(session);
        } catch {
          // VM is unresponsive — destroy and report crash
          await destroyOrphanedVM(session);
          await reportCrash(session, "vm_unresponsive_after_worker_restart");
        }
      } else {
        // VM process is dead — clean up resources and report crash
        await cleanupDeadVM(session);
        await reportCrash(session, "vm_process_dead_after_worker_restart");
      }
    }
  }
}
```

### 5c: Heartbeat system

**Worker → Convex heartbeat**: Every 15 seconds, the worker updates its Redis heartbeat key (30s TTL). If the key expires, other workers (or the same worker after restart) know this instance is dead.

**Worker → VM heartbeat**: Every 30 seconds, the worker sends a `heartbeat` vsock request to each active VM. If 3 consecutive heartbeats fail, the worker:
1. Records a crash report in Convex
2. Attempts to destroy the VM gracefully
3. Updates the `devWorkspaces` record status to `"error"`

```typescript
// worker/src/workspace/heartbeat.ts

class WorkspaceHeartbeat {
  private intervals = new Map<string, NodeJS.Timeout>();

  startMonitoring(workspaceId: string, session: SessionRecord): void {
    const interval = setInterval(async () => {
      try {
        const result = await vsockExec(session.vsockSocketPath, "heartbeat", 5_000);
        await redis.hset(`workspace:${workspaceId}`, "lastHeartbeatAt", Date.now());
        session.consecutiveFailures = 0;
      } catch {
        session.consecutiveFailures = (session.consecutiveFailures ?? 0) + 1;
        if (session.consecutiveFailures >= 3) {
          clearInterval(interval);
          await reportCrash(session, "heartbeat_timeout");
          await destroyWorkspace(workspaceId, "heartbeat_timeout");
        }
      }
    }, 30_000);
    this.intervals.set(workspaceId, interval);
  }
}
```

### 5d: Convex devWorkspaces table updates

Extend the existing `devWorkspaces` table to store recovery metadata:

```typescript
// Added fields to convex/schema.ts devWorkspaces table:
devWorkspaces: defineTable({
  // ... existing fields ...
  // New fields for crash recovery:
  firecrackerPid: v.optional(v.number()),
  vsockSocketPath: v.optional(v.string()),
  tapDevice: v.optional(v.string()),
  overlayPath: v.optional(v.string()),
  workerInstanceId: v.optional(v.string()),
  lastHeartbeatAt: v.optional(v.number()),
  defaultShellSessionId: v.optional(v.string()),
})
```

### Non-exfiltration guarantee

Recovery only reconnects to VMs via vsock (the same channel used during normal operation). No new network paths are opened. The egress filtering on the TAP device survives worker restart because iptables rules persist in the kernel.

---

## Component 6: Crash Reports in Convex

### Problem
When a workspace VM crashes, times out, or the worker dies, there's no record of what happened. Agents see opaque errors with no debugging path.

### Schema

```typescript
// convex/schema.ts — new table

workspaceCrashReports: defineTable({
  workspaceId: v.string(),
  bountyId: v.id("bounties"),
  agentId: v.id("users"),
  claimId: v.id("bountyClaims"),
  vmId: v.string(),
  workerInstanceId: v.string(),

  // Crash classification
  crashType: v.union(
    v.literal("vm_process_exited"),        // Firecracker process died
    v.literal("vm_unresponsive"),          // heartbeat timeout
    v.literal("worker_restart"),           // worker process restarted, VM orphaned
    v.literal("oom_killed"),               // VM hit memory limit
    v.literal("disk_full"),                // overlay filesystem full
    v.literal("provision_failed"),         // VM failed during provisioning
    v.literal("vsock_error"),              // vsock communication breakdown
    v.literal("network_error"),            // TAP/egress failure
    v.literal("timeout"),                  // TTL or idle timeout (informational)
    v.literal("unknown"),                  // unclassified
  ),

  // Diagnostics
  errorMessage: v.string(),
  lastKnownStatus: v.string(),
  vmUptimeMs: v.optional(v.number()),
  lastHeartbeatAt: v.optional(v.number()),
  lastActivityAt: v.optional(v.number()),
  resourceUsage: v.optional(v.object({
    cpuPercent: v.optional(v.number()),
    memoryMb: v.optional(v.number()),
    diskMb: v.optional(v.number()),
  })),

  // Recovery outcome
  recovered: v.boolean(),
  recoveryAction: v.optional(v.union(
    v.literal("reconnected"),              // VM was still alive, session restored
    v.literal("reprovisioned"),            // new VM was created
    v.literal("abandoned"),                // no recovery attempted
  )),

  // Host context
  hostMetrics: v.optional(v.object({
    totalActiveVMs: v.optional(v.number()),
    hostMemoryUsedPercent: v.optional(v.number()),
    hostCpuUsedPercent: v.optional(v.number()),
  })),

  createdAt: v.number(),
})
  .index("by_workspaceId", ["workspaceId"])
  .index("by_bountyId", ["bountyId"])
  .index("by_agentId", ["agentId"])
  .index("by_crashType", ["crashType"])
  .index("by_createdAt", ["createdAt"]),
```

### Convex functions

```typescript
// convex/workspaceCrashReports.ts

// Internal mutation — called by worker via HTTP endpoint
export const recordCrashReport = internalMutation({
  args: { /* fields from schema above */ },
  handler: async (ctx, args) => {
    await ctx.db.insert("workspaceCrashReports", {
      ...args,
      createdAt: Date.now(),
    });

    // Update the devWorkspace record
    const ws = await ctx.db
      .query("devWorkspaces")
      .withIndex("by_workspaceId", q => q.eq("workspaceId", args.workspaceId))
      .first();
    if (ws && ws.status !== "destroyed") {
      await ctx.db.patch(ws._id, {
        status: "error",
        errorMessage: `Crash: ${args.crashType} — ${args.errorMessage}`,
      });
    }
  },
});

// Query for agents (via MCP)
export const getCrashReports = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    // Auth check: agent must own the claim
    const user = await getCurrentUser(ctx);
    requireAuth(user);

    return ctx.db
      .query("workspaceCrashReports")
      .withIndex("by_bountyId", q => q.eq("bountyId", args.bountyId))
      .order("desc")
      .take(20);
  },
});
```

### HTTP endpoint

```typescript
// convex/http.ts — add endpoint

// POST /api/workspace/crash-report
// Auth: WORKER_SHARED_SECRET bearer token
http.route({
  path: "/api/workspace/crash-report",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    verifyWorkerSecret(request); // constant-time comparison
    const body = await request.json();
    await ctx.runMutation(internal.workspaceCrashReports.recordCrashReport, body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }),
});
```

### Worker crash reporter

```typescript
// worker/src/workspace/crashReporter.ts

export async function reportCrash(
  session: SessionRecord,
  crashType: string,
  errorMessage: string,
  recovered = false,
  recoveryAction?: string,
): Promise<void> {
  // Collect host metrics for context
  const hostMetrics = await collectHostMetrics();

  const report = {
    workspaceId: session.workspaceId,
    bountyId: session.bountyId,
    agentId: session.agentId,
    claimId: session.claimId,
    vmId: session.vmId,
    workerInstanceId: session.workerInstanceId,
    crashType,
    errorMessage,
    lastKnownStatus: session.status,
    vmUptimeMs: Date.now() - session.createdAt,
    lastHeartbeatAt: session.lastHeartbeatAt,
    lastActivityAt: session.lastActivityAt,
    recovered,
    recoveryAction,
    hostMetrics,
  };

  // POST to Convex
  await fetch(`${CONVEX_URL}/api/workspace/crash-report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WORKER_SHARED_SECRET}`,
    },
    body: JSON.stringify(report),
  }).catch(err => {
    // Last-resort: log locally if Convex is also unreachable
    logger.error("Failed to report crash to Convex", { report, error: String(err) });
  });
}
```

### MCP tool: `workspace_crash_reports`

```typescript
registerTool(server, "workspace_crash_reports",
  "View crash reports for your workspace. Useful for debugging VM failures.",
  {
    bountyId: z.string(),
  },
  async (args) => {
    requireScope("workspace:read");
    const user = requireAuthUser();
    const reports = await callConvex("workspaceCrashReports:getCrashReports", {
      bountyId: args.bountyId,
    });
    // Format as readable table
  }
);
```

---

## Component 7: Agent-Breed Abstraction Layer

### Problem
The MCP tools are hardcoded to a specific tool interface. Different agent platforms expect different tool shapes:

| Platform | Edit mechanism | Shell mechanism | File search |
|----------|---------------|----------------|-------------|
| Claude Code | `Edit(old_string, new_string)` | `Bash(command)` with persistent cwd | `Glob(pattern)` + `Grep(pattern)` |
| Codex | `apply_patch(v4a_diff)` | `shell(command)` with PTY | via shell (`find`, `grep`) |
| Devin | VSCode editor API | persistent terminal | VSCode search |
| Custom agents | varies | varies | varies |

### Design: Tool Profile System

Rather than building N different MCP servers, define **tool profiles** — named bundles of tool aliases and response format adapters.

```typescript
// mcp-server/src/lib/toolProfiles.ts

interface ToolProfile {
  name: string;                   // "claude-code" | "codex" | "devin" | "generic"
  toolAliases: Record<string, string>;  // maps profile tool name → canonical tool
  responseAdapters: Record<string, (result: unknown) => unknown>;
  defaultShellMode: "stateless" | "persistent";
}

const PROFILES: Record<string, ToolProfile> = {
  "claude-code": {
    name: "claude-code",
    toolAliases: {
      "Bash": "workspace_shell",
      "Read": "workspace_read_file",
      "Write": "workspace_write_file",
      "Edit": "workspace_edit_file",
      "Glob": "workspace_glob",
      "Grep": "workspace_grep",
    },
    responseAdapters: {
      // Claude Code expects line-numbered output for Read
      "workspace_read_file": formatWithLineNumbers,
    },
    defaultShellMode: "persistent",
  },
  "codex": {
    name: "codex",
    toolAliases: {
      "shell": "workspace_shell",
      "apply_patch": "workspace_apply_patch",  // V4A diff format adapter
    },
    responseAdapters: {
      "workspace_apply_patch": convertV4AToDiffEdits,
    },
    defaultShellMode: "persistent",
  },
  "generic": {
    name: "generic",
    // All tools available under canonical names
    toolAliases: {},
    responseAdapters: {},
    defaultShellMode: "persistent",
  },
};
```

### API key scoping

The agent's API key (stored in Convex `apiKeys` table) gains a `toolProfile` field:

```typescript
// convex/schema.ts — apiKeys table extension
apiKeys: defineTable({
  // ... existing fields ...
  toolProfile: v.optional(v.string()),  // "claude-code" | "codex" | "generic"
  agentPlatform: v.optional(v.string()), // free-form: "claude-code-v1.2", "codex-rs/0.1"
})
```

### MCP server: profile-aware tool registration

At server startup, the MCP server registers the **canonical** tool set. At request time, when the auth context is loaded from the API key, the tool profile determines:
1. Which tool aliases the agent sees
2. How responses are formatted

```typescript
// mcp-server/src/lib/context.ts — extension

export function getToolProfile(): ToolProfile {
  const user = getAuthUser();
  return PROFILES[user.toolProfile ?? "generic"];
}
```

### Codex compatibility: `apply_patch` adapter

For Codex-style agents, provide a V4A patch tool that translates to sequential `file_edit` operations:

```typescript
// mcp-server/src/tools/workspaceApplyPatch.ts

registerTool(server, "workspace_apply_patch",
  "Apply a V4A-format unified diff patch to workspace files.",
  {
    bountyId: z.string(),
    patch: z.string().describe("V4A format patch (*** Begin Patch / *** End Patch)"),
  },
  async (args) => {
    // 1. Parse V4A patch into individual file operations
    const ops = parseV4APatch(args.patch);

    // 2. Execute each operation via workspace_edit_file / workspace_write_file
    for (const op of ops) {
      switch (op.type) {
        case "update":
          // Convert context-anchored hunks to oldString/newString pairs
          for (const hunk of op.hunks) {
            await callWorker(ws.workerHost, "/api/workspace/edit-file", {
              workspaceId: ws.workspaceId,
              path: op.path,
              oldString: hunk.oldLines.join("\n"),
              newString: hunk.newLines.join("\n"),
            });
          }
          break;
        case "add":
          await callWorker(ws.workerHost, "/api/workspace/write-file", {
            workspaceId: ws.workspaceId,
            path: op.path,
            content: op.content,
          });
          break;
        case "delete":
          await callWorker(ws.workerHost, "/api/workspace/exec", {
            workspaceId: ws.workspaceId,
            command: `rm -f /workspace/${op.path}`,
          });
          break;
      }
    }
  }
);
```

### Future extensibility

New agent breeds add a new entry to `PROFILES`. The canonical tool set (workspace_shell, workspace_edit_file, workspace_glob, workspace_grep, workspace_read_file, workspace_write_file) remains stable. Adapters translate between the agent's expected interface and the canonical operations.

---

## Component 8: Rootfs Build Pipeline

### Problem
No automated way to build rootfs ext4 images. The Dockerfiles exist but the `docker export → dd → resize2fs` process is manual and undocumented except in comments.

### Solution: `worker/rootfs/Makefile`

```makefile
# worker/rootfs/Makefile

ROOTFS_DIR := /var/lib/firecracker/rootfs
VSOCK_AGENT_DIR := ../vsock-agent

# Languages and their image sizes
IMAGES := \
  base:512M \
  node-20:1G \
  python-312:1G \
  rust-stable:2G \
  go-122:1G \
  java-21:1500M

.PHONY: all clean vsock-agent

all: vsock-agent $(foreach img,$(IMAGES),$(word 1,$(subst :, ,$(img))).ext4)

# Build vsock-agent binary first
vsock-agent:
	$(MAKE) -C $(VSOCK_AGENT_DIR)

# Pattern rule: build Docker image → export → ext4
%.ext4: %.Dockerfile vsock-agent
	@echo "Building $* rootfs..."
	docker build -t arcagent-rootfs-$* -f $< .
	$(eval CONTAINER := $(shell docker create arcagent-rootfs-$*))
	docker export $(CONTAINER) | dd of=$@ bs=1M
	docker rm $(CONTAINER)
	resize2fs $@ $(word 2,$(subst :, ,$(filter $*:%,$(IMAGES))))
	@echo "Built $@"

# Install images to Firecracker rootfs directory
install: all
	@mkdir -p $(ROOTFS_DIR)
	@for img in $(foreach img,$(IMAGES),$(word 1,$(subst :, ,$(img)))); do \
		echo "Installing $$img.ext4 → $(ROOTFS_DIR)/$$img.ext4"; \
		cp $$img.ext4 $(ROOTFS_DIR)/$$img.ext4; \
	done

clean:
	rm -f *.ext4
	$(MAKE) -C $(VSOCK_AGENT_DIR) clean
```

### CI integration

```yaml
# .github/workflows/build-rootfs.yml

name: Build Rootfs Images
on:
  push:
    paths:
      - 'worker/rootfs/**'
      - 'worker/vsock-agent/**'
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.22' }
      - name: Build vsock-agent
        run: cd worker/vsock-agent && make
      - name: Build rootfs images
        run: cd worker/rootfs && make
      - name: Upload to S3
        run: |
          for img in worker/rootfs/*.ext4; do
            aws s3 cp "$img" "s3://${ROOTFS_BUCKET}/$(basename $img)"
          done
```

### Missing Dockerfiles

Currently only `base.Dockerfile` and `node.Dockerfile` exist. The following need to be created (minimal effort — each extends the base):

```
worker/rootfs/
├── base.Dockerfile          # exists
├── node.Dockerfile          # exists (node-20)
├── python.Dockerfile        # ADD: python 3.12 + pip + venv
├── rust.Dockerfile          # ADD: rustup + stable toolchain
├── go.Dockerfile            # ADD: go 1.22
├── java.Dockerfile          # ADD: openjdk 21 + gradle + maven
├── ruby.Dockerfile          # ADD: ruby 3.3 + bundler
├── php.Dockerfile           # ADD: php 8.4 + composer
├── dotnet.Dockerfile        # ADD: .NET 9 SDK
├── cpp.Dockerfile           # ADD: gcc 14 + cmake + valgrind
├── swift.Dockerfile         # ADD: swift 6 toolchain
└── kotlin.Dockerfile        # ADD: kotlin + JDK 21
```

Each follows the same pattern as `node.Dockerfile`: extend the base, install language runtime + package manager + standard tooling.

---

## Component 9: Dependency Caching via Snapshots

### Problem
Every workspace provision runs a full dependency install from scratch. For large projects, this adds 2-5 minutes to provisioning.

### Solution: Layer-based rootfs cache

Rather than full Firecracker snapshotting (complex, requires pausing the VM), use a simpler approach: **pre-baked dependency layers** stored as ext4 overlay images.

#### Phase 1: Package manager cache persistence

Mount a shared, read-only cache volume into VMs:

```typescript
// In createFirecrackerVM, add a second drive for the cache:
config["drives"] = [
  { drive_id: "rootfs", path_on_host: overlayPath, is_root_device: true, is_read_only: false },
  { drive_id: "cache", path_on_host: `/var/lib/firecracker/cache/${language}-cache.ext4`, is_root_device: false, is_read_only: true },
];

// In provisionWorkspace, mount the cache:
await vm.exec("mkdir -p /cache && mount /dev/vdb /cache", 10_000);
// Symlink package manager caches
await vm.exec("ln -sf /cache/npm /home/agent/.npm", 10_000);      // npm
await vm.exec("ln -sf /cache/pip /home/agent/.cache/pip", 10_000); // pip
```

#### Phase 2: Per-repo snapshot (future)

For bounties with known repos, pre-build a snapshot after `git clone + npm install`:

1. First agent claims bounty → full provision (clone + install) → extract dep cache
2. Subsequent agents claiming same bounty → warm start with pre-installed deps

This is an optimization that can be deferred. Phase 1 (shared cache volume) covers the common case.

---

## Security Analysis

### Non-exfiltration guarantees preserved

| Component | Exfiltration vector | Mitigation |
|-----------|-------------------|------------|
| Persistent shell (C2) | Agent runs `curl` to exfiltrate code | **Egress filtering**: TAP device only allows DNS (53) + HTTPS (443). GitHub domains blocked post-clone (SECURITY W1). Even for allowed HTTPS, the Squid SNI proxy (when `FC_HARDEN_EGRESS=true`) limits to allowlisted domains only. |
| Shell sessions | Agent sets env vars containing code | Env vars live inside the VM. vsock only returns stdout/stderr, never the env. |
| Edit tool (C3) | `oldString`/`newString` cross vsock | These are edit *instructions*, not file contents. The full file never leaves the VM. This is more secure than the current `workspace_write_file` which sends entire file content. |
| Glob/Grep (C4) | File listing and match snippets returned | File *paths* and *matched lines* are returned, not full file contents. This is equivalent to the current `workspace_search` and `workspace_list_files`. |
| Crash reports (C6) | Error messages might contain code | Crash reports only contain structured metadata (crash type, uptime, resource usage). No file contents or command outputs are included. |
| Redis persistence (C5) | Session metadata in Redis | Redis contains only structural metadata (paths, PIDs, IDs). No file contents. Redis is on the worker's private network, not accessible to agents. |
| Agent profiles (C7) | V4A patch adapter | The `apply_patch` adapter translates to `file_edit` operations that run inside the VM. Patches contain edit instructions, not different security boundaries. |

### New attack surfaces and mitigations

1. **PTY escape sequences**: Malicious command output could contain terminal escape sequences. Mitigation: the vsock-agent strips ANSI escape sequences from output before returning structured JSON.

2. **Session hijacking**: One agent's PTY session used by another agent. Mitigation: session lookup always requires the workspace ID, which is scoped to a specific agent+bounty claim. The MCP auth layer ensures agents can only access their own workspaces.

3. **vsock-agent compromise**: If the Go binary has a bug, an attacker running code inside the VM could exploit it. Mitigation: vsock-agent runs as root but validates all paths and user contexts. Command execution always drops to the `agent` user unless `user: "root"` is explicitly requested (and root requests are only made by the worker during setup, never proxied from MCP tools).

4. **Redis poisoning**: A compromised worker could write malicious session data to Redis. Mitigation: Redis is on a private network. Worker-to-Redis auth via `REDIS_URL` credentials. Session adoption during recovery validates VM liveness via vsock before trusting Redis data.

---

## Migration Plan

### Phase 1: Foundation (Week 1-2)
1. Build vsock-agent Go binary with all current request types (exec, exec_with_stdin, file_write, file_read)
2. Add heartbeat request type
3. Rootfs Makefile + CI pipeline
4. Verify existing tests pass with Go vsock-agent replacing the mystery binary

### Phase 2: Core Tools (Week 2-3)
4. Add `file_edit` to vsock-agent + worker endpoint + MCP tool
5. Add `file_glob` to vsock-agent + worker endpoint + MCP tool
6. Add `file_grep` (with ripgrep) to vsock-agent + worker endpoint + MCP tool

### Phase 3: Persistent Shell (Week 3-4)
7. Add PTY session management to vsock-agent
8. Add `session_create/exec/destroy` to vsock-agent
9. Worker endpoint: `/api/workspace/session-exec`
10. MCP tool: `workspace_shell`
11. Auto-create default session at provision time

### Phase 4: Crash Recovery (Week 4-5)
12. Redis session store (replace in-memory Map)
13. Worker startup recovery logic
14. Heartbeat system (worker ↔ VM)
15. Crash report Convex table + HTTP endpoint + recording
16. MCP tool: `workspace_crash_reports`

### Phase 5: Agent Profiles (Week 5-6)
17. Tool profile system in MCP server
18. `apply_patch` V4A adapter for Codex compatibility
19. API key `toolProfile` field
20. Documentation for adding new agent breeds

### Phase 6: Polish (Week 6-7)
21. Dependency caching (shared cache volume)
22. Missing language Dockerfiles
23. Expanded dependency install coverage in `installDependencies()`
24. Load testing: 10 concurrent workspace VMs with persistent shells

### Backwards compatibility

- All existing MCP tools remain unchanged
- `workspace_exec` continues to work (stateless one-shot)
- `workspace_search` becomes an alias for `workspace_grep`
- `workspace_write_file` continues to work for full-file writes
- No breaking changes to Convex schema (all new fields are optional)

---

## Testing Strategy

### Unit tests

| Component | Test approach |
|-----------|--------------|
| vsock-agent (Go) | Go test suite with mocked PTY, filesystem |
| handler_edit.go | Test: unique match, no match, ambiguous match, replace_all, path traversal, Unicode |
| handler_glob.go | Test: `**/*.ts`, nested dirs, symlinks, max results |
| handler_grep.go | Test: regex, case insensitive, context lines, binary file skip |
| handler_session.go | Test: create, exec with cwd persistence, env var persistence, concurrent sessions, idle timeout |
| sessionStore.ts | Test: Redis CRUD, recovery logic, heartbeat expiry |
| crashReporter.ts | Test: report generation, Convex POST, fallback logging |
| toolProfiles.ts | Test: alias resolution, response adapters, profile loading |

### Integration tests

1. **Full lifecycle**: provision workspace → shell_create → edit file → glob → grep → submit_solution → verification passes
2. **Crash recovery**: provision → kill worker → restart worker → verify session recovered
3. **Heartbeat timeout**: provision → freeze VM (SIGSTOP firecracker) → verify crash report generated
4. **Concurrent agents**: 5 agents, each with persistent shell, editing files simultaneously
5. **Agent profiles**: same task executed via Claude Code profile and Codex profile

### Security tests

1. **Path traversal**: `file_edit` with `../../etc/passwd` path → rejected
2. **Session isolation**: agent A's workspace tools reject agent B's workspace ID
3. **Egress filtering**: `workspace_shell` → `curl https://evil.com` → connection refused
4. **PTY escape injection**: command output with `\x1b]0;evil\x07` → stripped from response
5. **Crash report content**: verify no file contents leak into crash reports

---

## File Change Summary

### New files

```
worker/vsock-agent/                    # Go binary source (Component 1)
  main.go, protocol.go, handler_*.go, sandbox.go, go.mod, Makefile

worker/src/workspace/sessionStore.ts   # Redis-backed session store (Component 5)
worker/src/workspace/recovery.ts       # Startup recovery logic (Component 5)
worker/src/workspace/heartbeat.ts      # VM heartbeat monitor (Component 5)
worker/src/workspace/crashReporter.ts  # Crash report submission (Component 6)

worker/rootfs/Makefile                 # Rootfs build pipeline (Component 8)
worker/rootfs/python.Dockerfile        # Missing language images (Component 8)
worker/rootfs/rust.Dockerfile
worker/rootfs/go.Dockerfile
worker/rootfs/java.Dockerfile
worker/rootfs/ruby.Dockerfile
worker/rootfs/php.Dockerfile
worker/rootfs/dotnet.Dockerfile
worker/rootfs/cpp.Dockerfile
worker/rootfs/swift.Dockerfile
worker/rootfs/kotlin.Dockerfile

mcp-server/src/tools/workspaceShell.ts       # Persistent shell MCP tool (Component 2)
mcp-server/src/tools/workspaceEditFile.ts    # Surgical edit MCP tool (Component 3)
mcp-server/src/tools/workspaceGlob.ts        # Glob search MCP tool (Component 4)
mcp-server/src/tools/workspaceGrep.ts        # Grep search MCP tool (Component 4)
mcp-server/src/tools/workspaceApplyPatch.ts  # Codex V4A adapter (Component 7)
mcp-server/src/tools/workspaceCrashReports.ts # Crash reports MCP tool (Component 6)
mcp-server/src/lib/toolProfiles.ts           # Agent profile system (Component 7)

convex/workspaceCrashReports.ts        # Crash report Convex functions (Component 6)

.github/workflows/build-rootfs.yml     # CI for rootfs images (Component 8)
```

### Modified files

```
worker/src/vm/vsockChannel.ts          # New request/response types (Components 2-4)
worker/src/workspace/sessionManager.ts # Redis store integration, heartbeat (Components 5-6)
worker/src/api/routes.ts               # New endpoints: session-exec, edit-file, glob, grep
worker/rootfs/base.Dockerfile          # Add ripgrep (Component 4)

convex/schema.ts                       # workspaceCrashReports table + devWorkspaces extensions
convex/http.ts                         # crash-report endpoint

mcp-server/src/tools/index.ts          # Register new tools
mcp-server/src/lib/context.ts          # Tool profile awareness
```
