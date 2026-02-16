import { vi } from "vitest";
import { initWorkerClient, callWorker } from "./client";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("callWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initWorkerClient("test-worker-secret");
  });

  it("sends Bearer auth header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: "ok" }),
    });

    await callWorker("https://worker.example.com", "/api/exec", { cmd: "ls" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://worker.example.com/api/exec");
    expect(options.headers.Authorization).toBe("Bearer test-worker-secret");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.method).toBe("POST");
  });

  it("returns parsed JSON on 200", async () => {
    const responseData = { stdout: "file.ts", exitCode: 0 };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => responseData,
    });

    const result = await callWorker("https://worker.example.com", "/api/exec", {
      cmd: "ls",
    });

    expect(result).toEqual(responseData);
  });

  it("throws structured error on non-OK response with JSON body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: "workspace not found" }),
    });

    await expect(
      callWorker("https://worker.example.com", "/api/exec", { cmd: "ls" }),
    ).rejects.toThrow("workspace not found");
  });

  it("converts AbortError to readable timeout message", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    mockFetch.mockRejectedValueOnce(abortError);

    await expect(
      callWorker("https://worker.example.com", "/api/exec", { cmd: "sleep 999" }, 100),
    ).rejects.toThrow("Worker request timed out: /api/exec");
  });

  it("handles non-JSON error body and truncates to 200 chars", async () => {
    const longText = "x".repeat(500);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => longText,
    });

    await expect(
      callWorker("https://worker.example.com", "/api/exec", { cmd: "ls" }),
    ).rejects.toThrow(`Worker error (502). ${"x".repeat(200)}`);
  });
});
