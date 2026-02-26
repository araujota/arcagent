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
import { registerListMySubmissions } from "./tools/listMySubmissions";
import { registerCreateBounty } from "./tools/createBounty";
import { registerGetBountyGenerationStatus } from "./tools/getBountyGenerationStatus";
import { registerSetupPaymentMethod } from "./tools/setupPaymentMethod";
import { registerSetupPayoutAccount } from "./tools/setupPayoutAccount";
import { registerFundBountyEscrow } from "./tools/fundBountyEscrow";
import { registerCheckNotifications } from "./tools/checkNotifications";
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
import { registerTestBounty } from "./tools/testBounty";

export interface McpServerOptions {
  enableWorkspaceTools?: boolean;
  enableRegistration?: boolean;
}

export function createMcpServer(options?: McpServerOptions): McpServer {
  const {
    enableWorkspaceTools = true,
    enableRegistration = true,
  } = options ?? {};

  const server = new McpServer({
    name: "arcagent",
    version: "0.1.0",
  });

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
  registerGetSubmissionFeedback(server);
  registerListMySubmissions(server);
  registerCreateBounty(server);
  registerGetBountyGenerationStatus(server);
  registerSetupPaymentMethod(server);
  registerSetupPayoutAccount(server);
  registerFundBountyEscrow(server);
  registerCheckNotifications(server);
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
  }

  return server;
}
