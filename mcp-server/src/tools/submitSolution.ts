import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";
import { getWorkspaceForAgent, invalidateWorkspaceCache } from "../workspace/cache";
import { callWorker } from "../worker/client";
import { isMissingWorkspaceSessionError, staleWorkspaceSessionMessage } from "../workspace/workerErrors";

export function registerSubmitSolution(server: McpServer): void {
  registerTool(
    server,
    "submit_solution",
    "Submit your workspace changes for verification. Extracts a diff from your development VM and triggers the Firecracker TEE verification pipeline (build, lint, typecheck, security, sonarqube, BDD tests). Your workspace stays alive so you can iterate if verification fails.",
    {
      bountyId: z.string().describe("The bounty ID"),
      description: z.string().optional().describe("Optional description of your solution"),
    },
    async (args: {
      bountyId: string;
      description?: string;
    }) => {
      // SECURITY (H4): Enforce scope
      requireScope("submissions:write");
      // SECURITY (C1): Resolve agentId from auth context
      const authUser = getAuthUser();
      const agentId = authUser?.userId;
      if (!agentId) {
        return {
          content: [{ type: "text" as const, text: "Error: Authentication required." }],
          isError: true,
        };
      }

      // Resolve workspace from auth context — SECURITY (W6): never accept workspaceId from params
      const ws = await getWorkspaceForAgent(agentId, args.bountyId);
      if (!ws.found || ws.status !== "ready") {
        return {
          content: [{
            type: "text" as const,
            text: ws.found
              ? `Workspace is not ready (status: ${ws.status}). Use \`workspace_status\` to check.`
              : "No workspace found. Claim the bounty first with `claim_bounty`, then wait for the workspace to be ready.",
          }],
          isError: true,
        };
      }

      // Extract diff from dev VM
      let diffResult: {
        diffPatch: string;
        diffStat: string;
        changedFiles: string[];
        hasChanges: boolean;
      };
      try {
        diffResult = await callWorker<{
          diffPatch: string;
          diffStat: string;
          changedFiles: string[];
          hasChanges: boolean;
        }>(ws.workerHost, "/api/workspace/diff", {
          workspaceId: ws.workspaceId,
        });
      } catch (err) {
        if (isMissingWorkspaceSessionError(err)) {
          invalidateWorkspaceCache(agentId, args.bountyId);
          return {
            content: [{ type: "text" as const, text: staleWorkspaceSessionMessage() }],
            isError: true,
          };
        }
        const message = err instanceof Error ? err.message : "Failed to extract diff";
        return {
          content: [{ type: "text" as const, text: `Failed to extract diff from workspace: ${message}` }],
          isError: true,
        };
      }

      if (!diffResult.hasChanges) {
        return {
          content: [{
            type: "text" as const,
            text: "No changes detected in workspace. Make changes to the code first, then submit again.",
          }],
          isError: true,
        };
      }

      // Submit diff for verification via Convex
      try {
        const result = await callConvex<{
          submissionId: string;
          verificationId: string;
        }>("/api/mcp/submissions/create-from-workspace", {
          bountyId: args.bountyId,
          agentId,
          workspaceId: ws.workspaceId,
          diffPatch: diffResult.diffPatch,
          description: args.description,
        });

        let text = `# Solution Submitted\n\n`;
        text += `**Submission ID:** ${result.submissionId}\n`;
        text += `**Verification ID:** ${result.verificationId}\n`;
        text += `**Changed files:** ${diffResult.changedFiles.length}\n\n`;
        text += `### Changes\n\`\`\`\n${diffResult.diffStat}\n\`\`\`\n\n`;
        text += `## Verification Pipeline\n\n`;
        text += `Your changes are being verified in a clean Firecracker VM:\n`;
        text += `1. **Patch Apply** - Apply your diff to a clean clone\n`;
        text += `2. **Build** - Compile/install dependencies\n`;
        text += `3. **Lint** - Code quality check\n`;
        text += `4. **Typecheck** - Type safety verification\n`;
        text += `5. **Security** - Trivy + Semgrep scan\n`;
        text += `6. **SonarQube** - Static analysis\n`;
        text += `7. **Tests** - BDD test execution (public + hidden)\n\n`;
        text += `Use \`get_verification_status\` with verification ID \`${result.verificationId}\` to check progress.\n\n`;
        text += `Your workspace stays alive — if verification fails, read the feedback with \`get_submission_feedback\`, fix the code, and resubmit.`;

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Submission failed";
        return {
          content: [{ type: "text" as const, text: `Failed to submit solution: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
