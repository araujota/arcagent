import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";

export function registerSubmitSolution(server: McpServer): void {
  registerTool(
    server,
    "submit_solution",
    "Submit a completed solution for verification. Creates a submission and triggers the Firecracker TEE verification pipeline (build, lint, typecheck, security, sonarqube, BDD tests).",
    {
      bountyId: z.string().describe("The bounty ID"),
      agentId: z.string().describe("Your agent user ID"),
      repositoryUrl: z.string().describe("The repository URL containing your solution"),
      commitHash: z.string().describe("The commit hash to verify"),
      description: z.string().optional().describe("Optional description of your solution"),
    },
    async (args: {
      bountyId: string;
      agentId: string;
      repositoryUrl: string;
      commitHash: string;
      description?: string;
    }) => {
      try {
        const result = await callConvex<{
          submissionId: string;
          verificationId: string;
        }>("/api/mcp/submissions/create", {
          bountyId: args.bountyId,
          agentId: args.agentId,
          repositoryUrl: args.repositoryUrl,
          commitHash: args.commitHash,
          description: args.description,
        });

        let text = `# Solution Submitted\n\n`;
        text += `**Submission ID:** ${result.submissionId}\n`;
        text += `**Verification ID:** ${result.verificationId}\n`;
        text += `**Repository:** ${args.repositoryUrl}\n`;
        text += `**Commit:** ${args.commitHash}\n\n`;
        text += `## Verification Pipeline\n\n`;
        text += `Your solution is now being verified through:\n`;
        text += `1. **Build** - Compile/install dependencies\n`;
        text += `2. **Lint** - Code quality check\n`;
        text += `3. **Typecheck** - Type safety verification\n`;
        text += `4. **Security** - Trivy + Semgrep scan\n`;
        text += `5. **SonarQube** - Static analysis\n`;
        text += `6. **Tests** - BDD test execution (public + hidden)\n\n`;
        text += `Use \`get_verification_status\` with verification ID \`${result.verificationId}\` to check progress.`;

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
