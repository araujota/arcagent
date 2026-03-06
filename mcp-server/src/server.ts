import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListBounties } from "./tools/listBounties";
import { registerGetBountyDetails } from "./tools/getBountyDetails";
import { registerGetTestSuites } from "./tools/getTestSuites";
import { registerGetRepoMap } from "./tools/getRepoMap";
import { registerClaimBounty } from "./tools/claimBounty";
import { registerGetClaimStatus } from "./tools/getClaimStatus";
import { registerExtendClaim } from "./tools/extendClaim";
import { registerReleaseClaim } from "./tools/releaseClaim";
// getRepoAccess removed — agents use workspace tools instead
import { registerWorkspaceExec } from "./tools/workspaceExec";
import { registerWorkspaceReadFile } from "./tools/workspaceReadFile";
import { registerWorkspaceWriteFile } from "./tools/workspaceWriteFile";
import { registerWorkspaceStatus } from "./tools/workspaceStatus";
import { registerSubmitSolution } from "./tools/submitSolution";
import { registerGetVerificationStatus } from "./tools/getVerificationStatus";
import { registerGetVerificationLogs } from "./tools/getVerificationLogs";
import { registerListMySubmissions } from "./tools/listMySubmissions";
import { registerCreateBounty } from "./tools/createBounty";
import { registerGetBountyGenerationStatus } from "./tools/getBountyGenerationStatus";
import { registerSetupPaymentMethod } from "./tools/setupPaymentMethod";
import { registerSetupPayoutAccount } from "./tools/setupPayoutAccount";
import { registerFundBountyEscrow } from "./tools/fundBountyEscrow";
import { registerCheckNotifications } from "./tools/checkNotifications";
import { registerConfigureBountyNotifications } from "./tools/configureBountyNotifications";
import { registerCancelBounty } from "./tools/cancelBounty";
import { registerGetSubmissionFeedback } from "./tools/getSubmissionFeedback";
import { registerRegisterAccount } from "./tools/registerAccount";
import { registerImportWorkItem } from "./tools/importWorkItem";
import { registerGetMyAgentStats } from "./tools/getMyAgentStats";
import { registerGetAgentProfile } from "./tools/getAgentProfile";
import { registerRateAgent } from "./tools/rateAgent";
import { registerGetLeaderboard } from "./tools/getLeaderboard";
import { registerWorkspaceBatchRead } from "./tools/workspaceBatchRead";
import { registerWorkspaceBatchWrite } from "./tools/workspaceBatchWrite";
import { registerWorkspaceSearch } from "./tools/workspaceSearch";
import { registerWorkspaceListFiles } from "./tools/workspaceListFiles";
import { registerWorkspaceExecStream } from "./tools/workspaceExecStream";
import { registerWorkspaceShell } from "./tools/workspaceShell";
import { registerWorkspaceEditFile } from "./tools/workspaceEditFile";
import { registerWorkspaceGlob } from "./tools/workspaceGlob";
import { registerWorkspaceGrep } from "./tools/workspaceGrep";
import { registerWorkspaceApplyPatch } from "./tools/workspaceApplyPatch";
import { registerWorkspaceCrashReports } from "./tools/workspaceCrashReports";
import { registerCheckWorkerStatus } from "./tools/checkWorkerStatus";
import { registerWorkerHealth } from "./tools/workerHealth";
import { registerTestBounty } from "./tools/testBounty";
import { registerWorkspaceStartupLog } from "./tools/workspaceStartupLog";
import { z } from "zod";

export interface McpServerOptions {
  enableWorkspaceTools?: boolean;
  enableRegistration?: boolean;
}

function registerPromptsAndResources(server: McpServer): void {
  // Avoid SDK+zod deep generic inference blow-ups (same issue class as tool registration).
  (server.registerPrompt as any)(
    "bounty_execution_plan",
    {
      title: "Bounty Execution Plan",
      description: "Create a concrete implementation plan for an ArcAgent bounty before editing code.",
      argsSchema: {
        bountyId: z.string().describe("ArcAgent bounty ID"),
        constraints: z.string().optional().describe("Optional constraints, preferences, or deadlines"),
      },
    },
    async ({ bountyId, constraints }) => {
      const extra = constraints ? `\nConstraints: ${constraints}` : "";
      return {
        description: "Structured plan prompt for bounty implementation.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Build an implementation plan for ArcAgent bounty ${bountyId}.` +
                `${extra}\nInclude risk checks, test strategy, and verification steps before submission.`,
            },
          },
        ],
      };
    },
  );

  (server.registerPrompt as any)(
    "verification_triage",
    {
      title: "Verification Failure Triage",
      description: "Turn ArcAgent verification output into prioritized fixes and retry strategy.",
      argsSchema: {
        bountyId: z.string().describe("ArcAgent bounty ID"),
        verificationId: z.string().optional().describe("Verification ID if available"),
      },
    },
    async ({ bountyId, verificationId }) => ({
      description: "Prompt for debugging failed verification runs.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Analyze failed verification feedback for bounty ${bountyId}.` +
              (verificationId ? ` Verification: ${verificationId}.` : "") +
              " Produce ordered action items, likely root causes, and minimal retest commands.",
          },
        },
      ],
    }),
  );

  server.registerResource(
    "arcagent_overview",
    "arcagent://overview",
    {
      title: "ArcAgent MCP Overview",
      description: "High-level capabilities and connection model for ArcAgent MCP.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/markdown",
          text: [
            "# ArcAgent MCP",
            "",
            "ArcAgent provides tools for bounty discovery, claim management, workspace execution, and verified submissions.",
            "",
            "## Core flow",
            "1. `list_bounties`",
            "2. `claim_bounty`",
            "3. workspace tools (`workspace_read_file`, `workspace_exec`, etc.)",
            "4. `submit_solution`",
            "5. `get_verification_status`",
          ].join("\n"),
        },
      ],
    }),
  );

  server.registerResource(
    "arcagent_connection",
    "arcagent://connection",
    {
      title: "ArcAgent Connection Guide",
      description: "Authentication and remote endpoint details for ArcAgent MCP clients.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/markdown",
          text: [
            "# Connection",
            "",
            "- Remote MCP endpoint: `https://mcp.arcagent.dev/mcp`",
            "- Registration endpoint: `https://mcp.arcagent.dev/register`",
            "- Auth header: `Authorization: Bearer arc_<api_key>`",
            "",
            "Use `register_account` or `POST /api/mcp/register` only for first-time key creation.",
            "If already authenticated, reuse the existing API key and do not register again.",
          ].join("\n"),
        },
      ],
    }),
  );
}

export function createMcpServer(options?: McpServerOptions): McpServer {
  const {
    enableWorkspaceTools = true,
    enableRegistration = true,
  } = options ?? {};

  const server = new McpServer({
    name: "arcagent",
    version: "0.1.12",
  });

  registerPromptsAndResources(server);

  // Registration tool (available without pre-existing credentials)
  if (enableRegistration) {
    registerRegisterAccount(server);
  }

  // Core bounty tools (always available)
  registerListBounties(server);
  registerGetBountyDetails(server);
  registerGetTestSuites(server);
  registerGetRepoMap(server);
  registerClaimBounty(server);
  registerGetClaimStatus(server);
  registerExtendClaim(server);
  registerReleaseClaim(server);
  registerSubmitSolution(server);
  registerGetVerificationStatus(server);
  registerGetVerificationLogs(server);
  registerGetSubmissionFeedback(server);
  registerListMySubmissions(server);
  registerCreateBounty(server);
  registerGetBountyGenerationStatus(server);
  registerSetupPaymentMethod(server);
  registerSetupPayoutAccount(server);
  registerFundBountyEscrow(server);
  registerCheckNotifications(server);
  registerConfigureBountyNotifications(server);
  registerCancelBounty(server);
  registerImportWorkItem(server);
  registerGetMyAgentStats(server);
  registerGetAgentProfile(server);
  registerRateAgent(server);
  registerGetLeaderboard(server);
  registerTestBounty(server);

  // Workspace tools (scoped worker tokens; legacy direct secret still supported)
  if (enableWorkspaceTools) {
    registerWorkspaceExec(server);
    registerWorkspaceReadFile(server);
    registerWorkspaceWriteFile(server);
    registerWorkspaceStatus(server);
    registerWorkspaceBatchRead(server);
    registerWorkspaceBatchWrite(server);
    registerWorkspaceSearch(server);
    registerWorkspaceListFiles(server);
    registerWorkspaceExecStream(server);
    registerWorkspaceShell(server);
    registerWorkspaceEditFile(server);
    registerWorkspaceGlob(server);
    registerWorkspaceGrep(server);
    registerWorkspaceApplyPatch(server);
    registerWorkspaceCrashReports(server);
    registerCheckWorkerStatus(server);
    registerWorkerHealth(server);
    registerWorkspaceStartupLog(server);
  }

  return server;
}
