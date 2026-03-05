import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

const MAX_STREAM_OUTPUT = 500 * 1024; // 500 KB
const MAX_STREAM_TIMEOUT_MS = 300_000;
const MAX_POLL_ATTEMPTS = 300;

interface StreamPollResult {
  allStdout: string;
  allStderr: string;
  exitCode: number | undefined;
}

function parseTimeoutMs(raw: string | undefined): number {
  if (!raw) return MAX_STREAM_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return MAX_STREAM_TIMEOUT_MS;
  return Math.min(parsed, MAX_STREAM_TIMEOUT_MS);
}

async function pollStreamingOutput(
  workerHost: string,
  workspaceId: string,
  jobId: string,
): Promise<StreamPollResult> {
  let allStdout = "";
  let allStderr = "";
  let offset = 0;
  let done = false;
  let exitCode: number | undefined;
  let pollCount = 0;

  while (!done) {
    const delay = pollCount < 5 ? 2000 : 5000;
    await new Promise((r) => setTimeout(r, delay));
    pollCount++;

    const pollResult = await callWorker<{
      stdout: string;
      stderr: string;
      done: boolean;
      exitCode?: number;
      offset: number;
    }>(workerHost, "/api/workspace/exec-output", {
      workspaceId,
      jobId,
      offset,
    });

    allStdout += pollResult.stdout;
    allStderr = pollResult.stderr; // stderr is always full (not offset-based)
    offset = pollResult.offset;
    done = pollResult.done;
    exitCode = pollResult.exitCode;

    if (Buffer.byteLength(allStdout, "utf-8") > MAX_STREAM_OUTPUT) {
      allStdout = `${allStdout.slice(-MAX_STREAM_OUTPUT)}\n... [earlier output truncated]`;
      break;
    }
    if (pollCount > MAX_POLL_ATTEMPTS) {
      break;
    }
  }

  return { allStdout, allStderr, exitCode };
}

function buildExecStreamText(
  allStdout: string,
  allStderr: string,
  exitCode: number | undefined,
): string {
  const parts: string[] = [];
  if (allStdout) {
    parts.push(`**stdout:**\n\`\`\`\n${allStdout}\n\`\`\``);
  }
  if (allStderr) {
    parts.push(`**stderr:**\n\`\`\`\n${allStderr}\n\`\`\``);
  }
  if (exitCode !== undefined) {
    parts.push(`**exit code:** ${exitCode}`);
  } else {
    parts.push("**status:** command may still be running (polling stopped)");
  }
  return parts.join("\n\n");
}

export function registerWorkspaceExecStream(server: McpServer): void {
  registerTool(
    server,
    "workspace_exec_stream",
    "Run a long-running command (e.g. npm test, cargo build) with streaming output. " +
      "Unlike workspace_exec, this starts the command in the background and polls for output, " +
      "so you get the full build log even for commands that take minutes. " +
      "Max 5 minutes timeout. Use workspace_exec for quick commands (<30s).",
    {
      bountyId: z.string().describe("The bounty ID you have claimed"),
      command: z.string().describe("Shell command to execute"),
      timeoutMs: z
        .string()
        .optional()
        .describe("Timeout in ms (default 300000, max 300000)"),
    },
    async (args) => {
      // SECURITY (H4): Scope enforcement
      requireScope("workspace:exec");
      // SECURITY (C1): Identity from auth context
      const user = requireAuthUser();

      const ws = await getWorkspaceForAgent(user.userId, args.bountyId);
      if (!ws.found || ws.status !== "ready") {
        return {
          content: [
            {
              type: "text" as const,
              text: ws.found
                ? `Workspace is not ready (status: ${ws.status}).`
                : "No workspace found. Claim the bounty first.",
            },
          ],
          isError: true,
        };
      }

      try {
        const timeout = parseTimeoutMs(args.timeoutMs);

        // Start the streaming job
        const startResult = await callWorker<{ jobId: string }>(
          ws.workerHost,
          "/api/workspace/exec-stream",
          {
            workspaceId: ws.workspaceId,
            command: args.command,
            timeoutMs: timeout,
          },
        );

        const jobId = startResult.jobId;
        const pollResult = await pollStreamingOutput(
          ws.workerHost,
          ws.workspaceId,
          jobId,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: buildExecStreamText(
                pollResult.allStdout,
                pollResult.allStderr,
                pollResult.exitCode,
              ),
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Streaming exec failed";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
