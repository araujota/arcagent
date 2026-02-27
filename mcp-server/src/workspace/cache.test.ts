import { vi } from "vitest";

const mockCallConvex = vi.fn();

const mockWorkspace = {
  found: true,
  workspaceId: "ws_123",
  workerHost: "https://worker.example.com",
  status: "running",
  expiresAt: Date.now() + 3600_000,
};

describe("workspace cache", () => {
  let getWorkspaceForAgent: (typeof import("./cache"))["getWorkspaceForAgent"];
  let invalidateWorkspaceCache: (typeof import("./cache"))["invalidateWorkspaceCache"];
  let invalidateAllForAgent: (typeof import("./cache"))["invalidateAllForAgent"];

  beforeEach(async () => {
    mockCallConvex.mockClear();
    vi.useFakeTimers();
    // Reset modules to get a fresh internal cache Map each test
    vi.resetModules();
    vi.doMock("../convex/client", () => ({ callConvex: mockCallConvex }));
    const mod = await import("./cache");
    getWorkspaceForAgent = mod.getWorkspaceForAgent;
    invalidateWorkspaceCache = mod.invalidateWorkspaceCache;
    invalidateAllForAgent = mod.invalidateAllForAgent;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns cached data within 120s TTL", async () => {
    mockCallConvex.mockResolvedValueOnce(mockWorkspace);

    const first = await getWorkspaceForAgent("agent_1", "bounty_1");
    expect(mockCallConvex).toHaveBeenCalledTimes(1);

    // Advance 60s — within TTL
    vi.advanceTimersByTime(60_000);

    const second = await getWorkspaceForAgent("agent_1", "bounty_1");
    expect(mockCallConvex).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("refetches after TTL expires", async () => {
    mockCallConvex
      .mockResolvedValueOnce(mockWorkspace)
      .mockResolvedValueOnce({ ...mockWorkspace, status: "stopped" });

    await getWorkspaceForAgent("agent_1", "bounty_1");
    expect(mockCallConvex).toHaveBeenCalledTimes(1);

    // Advance past 120s TTL
    vi.advanceTimersByTime(121_000);

    const result = await getWorkspaceForAgent("agent_1", "bounty_1");
    expect(mockCallConvex).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("stopped");
  });

  it("invalidateWorkspaceCache removes specific entry", async () => {
    mockCallConvex
      .mockResolvedValueOnce(mockWorkspace)
      .mockResolvedValueOnce({ ...mockWorkspace, status: "restarted" });

    await getWorkspaceForAgent("agent_1", "bounty_1");
    expect(mockCallConvex).toHaveBeenCalledTimes(1);

    invalidateWorkspaceCache("agent_1", "bounty_1");

    const result = await getWorkspaceForAgent("agent_1", "bounty_1");
    expect(mockCallConvex).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("restarted");
  });

  it("invalidateAllForAgent removes all entries for that agent", async () => {
    mockCallConvex
      .mockResolvedValueOnce(mockWorkspace)
      .mockResolvedValueOnce({ ...mockWorkspace, workspaceId: "ws_456" })
      .mockResolvedValueOnce({ ...mockWorkspace, workspaceId: "ws_789" })
      .mockResolvedValueOnce({ ...mockWorkspace, workspaceId: "ws_new1" })
      .mockResolvedValueOnce({ ...mockWorkspace, workspaceId: "ws_new2" });

    // Cache two entries for agent_1
    await getWorkspaceForAgent("agent_1", "bounty_1");
    await getWorkspaceForAgent("agent_1", "bounty_2");
    // Cache one entry for agent_2
    await getWorkspaceForAgent("agent_2", "bounty_3");
    expect(mockCallConvex).toHaveBeenCalledTimes(3);

    // Invalidate all for agent_1
    invalidateAllForAgent("agent_1");

    // Both agent_1 entries should refetch
    await getWorkspaceForAgent("agent_1", "bounty_1");
    await getWorkspaceForAgent("agent_1", "bounty_2");
    expect(mockCallConvex).toHaveBeenCalledTimes(5);

    // agent_2 entry should still be cached
    await getWorkspaceForAgent("agent_2", "bounty_3");
    expect(mockCallConvex).toHaveBeenCalledTimes(5);
  });

  it("cache miss triggers Convex fetch", async () => {
    mockCallConvex.mockResolvedValueOnce(mockWorkspace);

    const result = await getWorkspaceForAgent("agent_1", "bounty_new");

    expect(mockCallConvex).toHaveBeenCalledWith("/api/mcp/workspace/lookup", {
      agentId: "agent_1",
      bountyId: "bounty_new",
    });
    expect(result).toEqual(mockWorkspace);
  });

  it("does not cache missing workspace lookups", async () => {
    mockCallConvex
      .mockResolvedValueOnce({ found: false, reason: "no_active_claim" })
      .mockResolvedValueOnce({ found: false, reason: "no_active_claim" });

    await getWorkspaceForAgent("agent_1", "bounty_missing");
    await getWorkspaceForAgent("agent_1", "bounty_missing");

    expect(mockCallConvex).toHaveBeenCalledTimes(2);
  });

  it("uses short TTL for provisioning workspaces", async () => {
    mockCallConvex
      .mockResolvedValueOnce({
        found: true,
        workspaceId: "ws_123",
        workerHost: "https://worker.example.com",
        status: "provisioning",
        expiresAt: Date.now() + 3600_000,
      })
      .mockResolvedValueOnce({
        found: true,
        workspaceId: "ws_123",
        workerHost: "https://worker.example.com",
        status: "ready",
        expiresAt: Date.now() + 3600_000,
      });

    await getWorkspaceForAgent("agent_1", "bounty_1");
    expect(mockCallConvex).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6_000);
    const result = await getWorkspaceForAgent("agent_1", "bounty_1");

    expect(mockCallConvex).toHaveBeenCalledTimes(2);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.status).toBe("ready");
    }
  });
});
