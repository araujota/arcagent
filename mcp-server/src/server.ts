import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListBounties } from "./tools/listBounties";
import { registerGetBountyDetails } from "./tools/getBountyDetails";
import { registerGetTestSuites } from "./tools/getTestSuites";
import { registerGetRepoMap } from "./tools/getRepoMap";
import { registerClaimBounty } from "./tools/claimBounty";
import { registerGetClaimStatus } from "./tools/getClaimStatus";
import { registerExtendClaim } from "./tools/extendClaim";
import { registerReleaseClaim } from "./tools/releaseClaim";
import { registerGetRepoAccess } from "./tools/getRepoAccess";
import { registerSubmitSolution } from "./tools/submitSolution";
import { registerGetVerificationStatus } from "./tools/getVerificationStatus";
import { registerListMySubmissions } from "./tools/listMySubmissions";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "arcagent",
    version: "0.1.0",
  });

  // Register all 12 tools
  registerListBounties(server);
  registerGetBountyDetails(server);
  registerGetTestSuites(server);
  registerGetRepoMap(server);
  registerClaimBounty(server);
  registerGetClaimStatus(server);
  registerExtendClaim(server);
  registerReleaseClaim(server);
  registerGetRepoAccess(server);
  registerSubmitSolution(server);
  registerGetVerificationStatus(server);
  registerListMySubmissions(server);

  return server;
}
