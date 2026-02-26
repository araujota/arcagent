import { vi } from "vitest";

// Mock all tool registration modules
vi.mock("./tools/listBounties", () => ({ registerListBounties: vi.fn() }));
vi.mock("./tools/getBountyDetails", () => ({ registerGetBountyDetails: vi.fn() }));
vi.mock("./tools/getTestSuites", () => ({ registerGetTestSuites: vi.fn() }));
vi.mock("./tools/getRepoMap", () => ({ registerGetRepoMap: vi.fn() }));
vi.mock("./tools/claimBounty", () => ({ registerClaimBounty: vi.fn() }));
vi.mock("./tools/getClaimStatus", () => ({ registerGetClaimStatus: vi.fn() }));
vi.mock("./tools/extendClaim", () => ({ registerExtendClaim: vi.fn() }));
vi.mock("./tools/releaseClaim", () => ({ registerReleaseClaim: vi.fn() }));
vi.mock("./tools/workspaceExec", () => ({ registerWorkspaceExec: vi.fn() }));
vi.mock("./tools/workspaceReadFile", () => ({ registerWorkspaceReadFile: vi.fn() }));
vi.mock("./tools/workspaceWriteFile", () => ({ registerWorkspaceWriteFile: vi.fn() }));
vi.mock("./tools/workspaceStatus", () => ({ registerWorkspaceStatus: vi.fn() }));
vi.mock("./tools/submitSolution", () => ({ registerSubmitSolution: vi.fn() }));
vi.mock("./tools/getVerificationStatus", () => ({ registerGetVerificationStatus: vi.fn() }));
vi.mock("./tools/listMySubmissions", () => ({ registerListMySubmissions: vi.fn() }));
vi.mock("./tools/createBounty", () => ({ registerCreateBounty: vi.fn() }));
vi.mock("./tools/getBountyGenerationStatus", () => ({ registerGetBountyGenerationStatus: vi.fn() }));
vi.mock("./tools/setupPaymentMethod", () => ({ registerSetupPaymentMethod: vi.fn() }));
vi.mock("./tools/setupPayoutAccount", () => ({ registerSetupPayoutAccount: vi.fn() }));
vi.mock("./tools/fundBountyEscrow", () => ({ registerFundBountyEscrow: vi.fn() }));
vi.mock("./tools/checkNotifications", () => ({ registerCheckNotifications: vi.fn() }));
vi.mock("./tools/cancelBounty", () => ({ registerCancelBounty: vi.fn() }));
vi.mock("./tools/getSubmissionFeedback", () => ({ registerGetSubmissionFeedback: vi.fn() }));
vi.mock("./tools/registerAccount", () => ({ registerRegisterAccount: vi.fn() }));
vi.mock("./tools/importWorkItem", () => ({ registerImportWorkItem: vi.fn() }));
vi.mock("./tools/getMyAgentStats", () => ({ registerGetMyAgentStats: vi.fn() }));
vi.mock("./tools/getAgentProfile", () => ({ registerGetAgentProfile: vi.fn() }));
vi.mock("./tools/rateAgent", () => ({ registerRateAgent: vi.fn() }));
vi.mock("./tools/getLeaderboard", () => ({ registerGetLeaderboard: vi.fn() }));
vi.mock("./tools/workspaceBatchRead", () => ({ registerWorkspaceBatchRead: vi.fn() }));
vi.mock("./tools/workspaceBatchWrite", () => ({ registerWorkspaceBatchWrite: vi.fn() }));
vi.mock("./tools/workspaceSearch", () => ({ registerWorkspaceSearch: vi.fn() }));
vi.mock("./tools/workspaceListFiles", () => ({ registerWorkspaceListFiles: vi.fn() }));
vi.mock("./tools/workspaceExecStream", () => ({ registerWorkspaceExecStream: vi.fn() }));
vi.mock("./tools/workspaceShell", () => ({ registerWorkspaceShell: vi.fn() }));
vi.mock("./tools/workspaceEditFile", () => ({ registerWorkspaceEditFile: vi.fn() }));
vi.mock("./tools/workspaceGlob", () => ({ registerWorkspaceGlob: vi.fn() }));
vi.mock("./tools/workspaceGrep", () => ({ registerWorkspaceGrep: vi.fn() }));
vi.mock("./tools/workspaceApplyPatch", () => ({ registerWorkspaceApplyPatch: vi.fn() }));
vi.mock("./tools/workspaceCrashReports", () => ({ registerWorkspaceCrashReports: vi.fn() }));
vi.mock("./tools/checkWorkerStatus", () => ({ registerCheckWorkerStatus: vi.fn() }));

import { createMcpServer } from "./server";

import { registerListBounties } from "./tools/listBounties";
import { registerGetBountyDetails } from "./tools/getBountyDetails";
import { registerGetTestSuites } from "./tools/getTestSuites";
import { registerGetRepoMap } from "./tools/getRepoMap";
import { registerClaimBounty } from "./tools/claimBounty";
import { registerGetClaimStatus } from "./tools/getClaimStatus";
import { registerExtendClaim } from "./tools/extendClaim";
import { registerReleaseClaim } from "./tools/releaseClaim";
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

describe("createMcpServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an McpServer instance", () => {
    const server = createMcpServer();
    expect(typeof server).toBe("object");
    expect(server).toBeDefined();
    expect(server).not.toBeNull();
    // McpServer should have a connect method
    expect(typeof server.connect).toBe("function");
  });

  it("calls all 34 register functions", () => {
    createMcpServer();

    const allRegisterFns = [
      registerRegisterAccount,
      registerListBounties,
      registerGetBountyDetails,
      registerGetTestSuites,
      registerGetRepoMap,
      registerClaimBounty,
      registerGetClaimStatus,
      registerExtendClaim,
      registerReleaseClaim,
      registerWorkspaceExec,
      registerWorkspaceReadFile,
      registerWorkspaceWriteFile,
      registerWorkspaceStatus,
      registerWorkspaceBatchRead,
      registerWorkspaceBatchWrite,
      registerWorkspaceSearch,
      registerWorkspaceListFiles,
      registerWorkspaceExecStream,
      registerSubmitSolution,
      registerGetVerificationStatus,
      registerGetSubmissionFeedback,
      registerListMySubmissions,
      registerCreateBounty,
      registerGetBountyGenerationStatus,
      registerSetupPaymentMethod,
      registerSetupPayoutAccount,
      registerFundBountyEscrow,
      registerCheckNotifications,
      registerCancelBounty,
      registerImportWorkItem,
      registerGetMyAgentStats,
      registerGetAgentProfile,
      registerRateAgent,
      registerGetLeaderboard,
      registerWorkspaceShell,
      registerWorkspaceEditFile,
      registerWorkspaceGlob,
      registerWorkspaceGrep,
      registerWorkspaceApplyPatch,
      registerWorkspaceCrashReports,
      registerCheckWorkerStatus,
    ];

    expect(allRegisterFns).toHaveLength(41);

    for (const fn of allRegisterFns) {
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(expect.anything());
    }
  });
});
