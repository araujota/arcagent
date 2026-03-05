import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { registerTool } from "../lib/toolHelper";

// ---------------------------------------------------------------------------
// V4A Patch Parser
// ---------------------------------------------------------------------------

/** Represents a single operation parsed from a V4A patch. */
interface PatchOperation {
  type: "add" | "update" | "delete";
  path: string;
  moveTo?: string;
  /** For "add": lines to write (without leading '+'). */
  addLines?: string[];
  /** For "update": parsed sections with context anchors and change lines. */
  sections?: PatchSection[];
}

/** A section within an update hunk, anchored by an @@ line. */
interface PatchSection {
  anchor: string | null;
  changes: PatchChange[];
  isEof: boolean;
}

interface PatchChange {
  type: "insert" | "delete" | "context";
  text: string;
}

/**
 * Parse V4A patch format into structured operations.
 *
 * Format:
 *   *** Begin Patch
 *   *** Update File: path/to/file.ts
 *   @@ context anchor line
 *   -removed line
 *   +added line
 *    context line (space prefix = keep)
 *   *** Add File: path/to/new.ts
 *   +line 1
 *   +line 2
 *   *** Delete File: path/to/old.ts
 *   *** End Patch
 */
export function parseV4APatch(patch: string): PatchOperation[] {
  const lines = patch.split("\n");
  const operations: PatchOperation[] = [];
  const beginIndex = findBeginPatchIndex(lines);
  if (beginIndex < 0) {
    throw new Error("Invalid V4A patch: missing '*** Begin Patch' header");
  }

  let i = beginIndex + 1;
  let currentOp: PatchOperation | null = null;
  let currentSection: PatchSection | null = null;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "*** End Patch") {
      finalizeCurrentOperation(operations, () => currentOp, (next) => {
        currentOp = next;
      }, () => currentSection, (next) => {
        currentSection = next;
      });
      break;
    }

    const headerOperation = parseOperationHeader(trimmed);
    if (headerOperation) {
      finalizeCurrentOperation(operations, () => currentOp, (next) => {
        currentOp = next;
      }, () => currentSection, (next) => {
        currentSection = next;
      });
      currentOp = headerOperation;
      i++;
      continue;
    }

    if (handleUpdateDirective(line, trimmed, () => currentOp, () => currentSection, (next) => {
      currentSection = next;
    })) {
      i++;
      continue;
    }

    if (appendUpdateChange(line, currentOp, currentSection)) {
      i++;
      continue;
    }

    if (appendAddLine(line, currentOp)) {
      i++;
      continue;
    }

    i++;
  }

  finalizeCurrentOperation(operations, () => currentOp, (next) => {
    currentOp = next;
  }, () => currentSection, (next) => {
    currentSection = next;
  });

  if (operations.length === 0) {
    throw new Error("Invalid V4A patch: no operations found");
  }

  return operations;
}

function findBeginPatchIndex(lines: string[]): number {
  return lines.findIndex((line) => line.trim() === "*** Begin Patch");
}

function parseOperationHeader(trimmed: string): PatchOperation | null {
  if (trimmed.startsWith("*** Add File:")) {
    return { type: "add", path: trimmed.slice("*** Add File:".length).trim(), addLines: [] };
  }
  if (trimmed.startsWith("*** Delete File:")) {
    return { type: "delete", path: trimmed.slice("*** Delete File:".length).trim() };
  }
  if (trimmed.startsWith("*** Update File:")) {
    return { type: "update", path: trimmed.slice("*** Update File:".length).trim(), sections: [] };
  }
  return null;
}

function finalizeCurrentOperation(
  operations: PatchOperation[],
  getCurrentOp: () => PatchOperation | null,
  setCurrentOp: (next: PatchOperation | null) => void,
  getCurrentSection: () => PatchSection | null,
  setCurrentSection: (next: PatchSection | null) => void,
): void {
  const currentOp = getCurrentOp();
  if (!currentOp) return;
  const currentSection = getCurrentSection();
  if (currentSection && currentOp.sections) {
    currentOp.sections.push(currentSection);
  }
  operations.push(currentOp);
  setCurrentSection(null);
  setCurrentOp(null);
}

function handleUpdateDirective(
  line: string,
  trimmed: string,
  getCurrentOp: () => PatchOperation | null,
  getCurrentSection: () => PatchSection | null,
  setCurrentSection: (next: PatchSection | null) => void,
): boolean {
  const currentOp = getCurrentOp();
  if (currentOp?.type !== "update") return false;

  if (trimmed.startsWith("*** Move to:")) {
    currentOp.moveTo = trimmed.slice("*** Move to:".length).trim();
    return true;
  }
  if (trimmed === "*** End of File") {
    const currentSection = getCurrentSection();
    if (currentSection) {
      currentSection.isEof = true;
      currentOp.sections?.push(currentSection);
      setCurrentSection(null);
    }
    return true;
  }
  if (line === "@@" || line.startsWith("@@ ")) {
    const currentSection = getCurrentSection();
    if (currentSection && currentOp.sections) {
      currentOp.sections.push(currentSection);
    }
    const anchor = line === "@@" ? null : line.slice(3);
    setCurrentSection({ anchor, changes: [], isEof: false });
    return true;
  }
  return false;
}

function appendUpdateChange(line: string, currentOp: PatchOperation | null, currentSection: PatchSection | null): boolean {
  if (currentOp?.type !== "update" || !currentSection) return false;
  if (line.startsWith("+")) {
    currentSection.changes.push({ type: "insert", text: line.slice(1) });
    return true;
  }
  if (line.startsWith("-")) {
    currentSection.changes.push({ type: "delete", text: line.slice(1) });
    return true;
  }
  if (line.startsWith(" ")) {
    currentSection.changes.push({ type: "context", text: line.slice(1) });
    return true;
  }
  if (line === "") {
    currentSection.changes.push({ type: "context", text: "" });
    return true;
  }
  return false;
}

function appendAddLine(line: string, currentOp: PatchOperation | null): boolean {
  if (currentOp?.type !== "add" || !currentOp.addLines) return false;
  if (!line.startsWith("+")) return true;
  currentOp.addLines.push(line.slice(1));
  return true;
}

// ---------------------------------------------------------------------------
// Build edit-file body from V4A update sections
//
// For each section in an update operation, we construct an oldString/newString
// pair that can be applied by the worker's edit-file endpoint.
// ---------------------------------------------------------------------------

interface EditOperation {
  path: string;
  oldString: string;
  newString: string;
}

type WorkspaceRecord = Awaited<ReturnType<typeof getWorkspaceForAgent>>;
type FoundWorkspace = Extract<WorkspaceRecord, { found: true }>;

interface ToolResponse {
  [key: string]: unknown;
  content: [{ type: "text"; text: string }];
  isError?: boolean;
}

function buildEditOperations(op: PatchOperation): EditOperation[] {
  if (op.type !== "update" || !op.sections) return [];

  const edits: EditOperation[] = [];
  const targetPath = op.moveTo ?? op.path;

  for (const section of op.sections) {
    const oldLines: string[] = [];
    const newLines: string[] = [];

    // If there is an anchor, it becomes the first context line
    if (section.anchor !== null) {
      oldLines.push(section.anchor);
      newLines.push(section.anchor);
    }

    for (const change of section.changes) {
      switch (change.type) {
        case "context":
          oldLines.push(change.text);
          newLines.push(change.text);
          break;
        case "delete":
          oldLines.push(change.text);
          break;
        case "insert":
          newLines.push(change.text);
          break;
      }
    }

    // Only produce an edit if there is actually a difference
    const oldText = oldLines.join("\n");
    const newText = newLines.join("\n");
    if (oldText !== newText) {
      edits.push({ path: targetPath, oldString: oldText, newString: newText });
    }
  }

  return edits;
}

function buildTextResponse(text: string, isError = false): ToolResponse {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function buildWorkspaceUnavailableResponse(ws: WorkspaceRecord): ToolResponse {
  return buildTextResponse(
    ws.found
      ? `Workspace is not ready (status: ${ws.status}).`
      : "No workspace found. Claim the bounty first.",
    true,
  );
}

function parsePatchOperations(patch: string): { operations?: PatchOperation[]; error?: ToolResponse } {
  try {
    return { operations: parseV4APatch(patch) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Patch parsing failed";
    return { error: buildTextResponse(`Parse error: ${message}`, true) };
  }
}

function hasBlockedTraversal(op: PatchOperation): boolean {
  const paths = [op.path, op.moveTo].filter(Boolean) as string[];
  return paths.some((path) => {
    const normalized = path.replace(/\\/g, "/");
    return normalized.includes("..") && !normalized.startsWith("/workspace/");
  });
}

async function applyAddOperation(ws: FoundWorkspace, op: PatchOperation): Promise<string> {
  const content = (op.addLines ?? []).join("\n");
  const writeResult = await callWorker<{
    bytesWritten: number;
    path: string;
  }>(ws.workerHost, "/api/workspace/write-file", {
    workspaceId: ws.workspaceId,
    path: op.path,
    content,
  });
  return `- \`${writeResult.path}\` -- CREATED (${writeResult.bytesWritten} bytes)`;
}

async function applyDeleteOperation(ws: FoundWorkspace, op: PatchOperation): Promise<string> {
  await callWorker<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>(ws.workerHost, "/api/workspace/exec", {
    workspaceId: ws.workspaceId,
    command: `rm -f "${op.path}"`,
    timeoutMs: 10000,
  });
  return `- \`${op.path}\` -- DELETED`;
}

async function applyRenameIfNeeded(ws: FoundWorkspace, op: PatchOperation, results: string[]): Promise<void> {
  if (!op.moveTo || op.moveTo === op.path) return;
  await callWorker<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>(ws.workerHost, "/api/workspace/exec", {
    workspaceId: ws.workspaceId,
    command: `mkdir -p "$(dirname "${op.moveTo}")" && mv "${op.path}" "${op.moveTo}"`,
    timeoutMs: 10000,
  });
  results.push(`- \`${op.path}\` -- RENAMED to \`${op.moveTo}\``);
}

async function applyUpdateOperation(ws: FoundWorkspace, op: PatchOperation): Promise<string[]> {
  const results: string[] = [];
  await applyRenameIfNeeded(ws, op, results);

  const edits = buildEditOperations(op);
  const targetPath = op.moveTo ?? op.path;
  if (edits.length === 0 && !op.moveTo) {
    results.push(`- \`${op.path}\` -- NO CHANGES (no diff sections)`);
    return results;
  }

  let totalReplacements = 0;
  for (const edit of edits) {
    const editResult = await callWorker<{
      path: string;
      replacements: number;
    }>(ws.workerHost, "/api/workspace/edit-file", {
      workspaceId: ws.workspaceId,
      path: edit.path,
      oldString: edit.oldString,
      newString: edit.newString,
      replaceAll: false,
    });
    totalReplacements += editResult.replacements;
  }

  if (edits.length > 0) {
    results.push(
      `- \`${targetPath}\` -- UPDATED (${edits.length} section${edits.length > 1 ? "s" : ""}, ${totalReplacements} replacement${totalReplacements > 1 ? "s" : ""})`,
    );
  }

  return results;
}

async function applyOperation(ws: FoundWorkspace, op: PatchOperation): Promise<string[]> {
  switch (op.type) {
    case "add":
      return [await applyAddOperation(ws, op)];
    case "delete":
      return [await applyDeleteOperation(ws, op)];
    case "update":
      return applyUpdateOperation(ws, op);
  }
}

function buildPatchSummary(operationsCount: number, errors: number): string {
  if (errors > 0) {
    return `Patch applied with ${errors} error${errors > 1 ? "s" : ""} (${operationsCount} operations):`;
  }
  return `Patch applied successfully (${operationsCount} operation${operationsCount > 1 ? "s" : ""}):`;
}

// ---------------------------------------------------------------------------
// MCP Tool Registration
// ---------------------------------------------------------------------------

export function registerWorkspaceApplyPatch(server: McpServer): void {
  registerTool(
    server,
    "workspace_apply_patch",
    "Apply a V4A-format patch to your workspace. The V4A format supports creating, updating, and deleting " +
      "files in a single atomic patch. Format:\n" +
      "```\n" +
      "*** Begin Patch\n" +
      "*** Update File: src/main.ts\n" +
      "@@ context anchor line\n" +
      "-removed line\n" +
      "+added line\n" +
      " kept line\n" +
      "*** Add File: src/new.ts\n" +
      "+line 1\n" +
      "+line 2\n" +
      "*** Delete File: src/old.ts\n" +
      "*** End Patch\n" +
      "```\n" +
      "Context lines (prefixed with space) and @@ anchors locate the edit position. " +
      "No line numbers needed.",
    {
      bountyId: z.string().describe("The bounty ID you have claimed"),
      patch: z.string().describe("V4A-format patch string"),
    },
    async (args) => {
      // SECURITY (H4): Scope enforcement — needs both read (for context matching) and write
      requireScope("workspace:write");
      // SECURITY (C1): Identity from auth context
      const user = requireAuthUser();

      const workspace = await getWorkspaceForAgent(user.userId, args.bountyId);
      if (!workspace.found || workspace.status !== "ready") {
        return buildWorkspaceUnavailableResponse(workspace);
      }
      const ws: FoundWorkspace = workspace;

      const parsedPatch = parsePatchOperations(args.patch);
      if (!parsedPatch.operations) return parsedPatch.error!;
      const operations = parsedPatch.operations;

      const results: string[] = [];
      let errors = 0;

      for (const op of operations) {
        if (hasBlockedTraversal(op)) {
          results.push(`- \`${op.path}\` -- SKIPPED: path traversal not allowed`);
          errors++;
          continue;
        }

        try {
          const operationResults = await applyOperation(ws, op);
          results.push(...operationResults);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Operation failed";
          results.push(`- \`${op.path}\` -- ERROR: ${message}`);
          errors++;
        }
      }

      const summary = buildPatchSummary(operations.length, errors);

      return buildTextResponse(`${summary}\n${results.join("\n")}`, errors > 0);
    },
  );
}
