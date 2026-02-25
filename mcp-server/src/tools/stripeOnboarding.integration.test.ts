import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));

import { callConvex } from "../convex/client";
import { runWithAuth } from "../lib/context";
import type { AuthenticatedUser } from "../lib/types";
import { registerSetupPaymentMethod } from "./setupPaymentMethod";
import { registerSetupPayoutAccount } from "./setupPayoutAccount";

const mockCallConvex = vi.mocked(callConvex);

function createMockServer() {
  const tools: Record<string, { handler: Function }> = {};
  return {
    tool: (_name: string, _description: string, _schema: unknown, handler: Function) => {
      tools[_name] = { handler };
    },
    tools,
  };
}

const setupPaymentUser: AuthenticatedUser = {
  userId: "user_payment_1",
  name: "Payment Agent",
  email: "payment@agent.dev",
  role: "agent",
  scopes: ["bounties:create", "bounties:read"],
};

const setupPayoutUser: AuthenticatedUser = {
  userId: "user_payout_1",
  name: "Payout Agent",
  email: "payout@agent.dev",
  role: "agent",
  scopes: ["submissions:write", "bounties:read"],
};

describe("Stripe onboarding integration tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("setup_payment_method returns hosted checkout URL and setup details", async () => {
    const mockServer = createMockServer();
    registerSetupPaymentMethod(mockServer as any);
    const handler = mockServer.tools["setup_payment_method"].handler;

    mockCallConvex.mockResolvedValue({
      clientSecret: "seti_client_secret_123",
      setupIntentId: "seti_123",
      customerId: "cus_123",
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
    });

    const result = await runWithAuth(setupPaymentUser, () =>
      handler({ email: "payment@agent.dev", name: "Payment Agent" }, {}),
    );

    expect(result.isError).toBeUndefined();
    expect(mockCallConvex).toHaveBeenCalledWith("/api/mcp/stripe/setup-intent", {
      userId: "user_payment_1",
      email: "payment@agent.dev",
      name: "Payment Agent",
    });
    const text = result.content[0].text;
    expect(text).toContain("seti_123");
    expect(text).toContain("cus_123");
    expect(text).toContain("seti_client_secret_123");
    expect(text).toContain("https://checkout.stripe.com/c/pay/cs_test_123");
  });

  it("setup_payment_method throws authentication error without auth context", async () => {
    const mockServer = createMockServer();
    registerSetupPaymentMethod(mockServer as any);
    const handler = mockServer.tools["setup_payment_method"].handler;

    await expect(
      handler({ email: "payment@agent.dev", name: "Payment Agent" }, {}),
    ).rejects.toThrow("Authentication required");
    expect(mockCallConvex).not.toHaveBeenCalled();
  });

  it("setup_payout_account returns Stripe Connect onboarding URL", async () => {
    const mockServer = createMockServer();
    registerSetupPayoutAccount(mockServer as any);
    const handler = mockServer.tools["setup_payout_account"].handler;

    mockCallConvex.mockResolvedValue({
      accountId: "acct_123",
      onboardingUrl: "https://connect.stripe.com/setup/s/acct_123",
    });

    const result = await runWithAuth(setupPayoutUser, () =>
      handler({ email: "payout@agent.dev" }, {}),
    );

    expect(result.isError).toBeUndefined();
    expect(mockCallConvex).toHaveBeenCalledWith("/api/mcp/stripe/connect-onboarding", {
      userId: "user_payout_1",
      email: "payout@agent.dev",
    });
    const text = result.content[0].text;
    expect(text).toContain("acct_123");
    expect(text).toContain("https://connect.stripe.com/setup/s/acct_123");
  });

  it("setup_payout_account enforces required scope", async () => {
    const mockServer = createMockServer();
    registerSetupPayoutAccount(mockServer as any);
    const handler = mockServer.tools["setup_payout_account"].handler;
    const noScopeUser: AuthenticatedUser = {
      userId: "user_no_scope",
      name: "No Scope",
      email: "noscope@agent.dev",
      role: "agent",
      scopes: ["bounties:read"],
    };

    await expect(
      runWithAuth(noScopeUser, () => handler({ email: "noscope@agent.dev" }, {})),
    ).rejects.toThrow('requires the "submissions:write" scope');
    expect(mockCallConvex).not.toHaveBeenCalled();
  });

  it("setup_payout_account surfaces backend errors", async () => {
    const mockServer = createMockServer();
    registerSetupPayoutAccount(mockServer as any);
    const handler = mockServer.tools["setup_payout_account"].handler;

    mockCallConvex.mockRejectedValue(new Error("Stripe onboarding unavailable"));

    const result = await runWithAuth(setupPayoutUser, () =>
      handler({ email: "payout@agent.dev" }, {}),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to setup payout account");
    expect(result.content[0].text).toContain("Stripe onboarding unavailable");
  });
});
