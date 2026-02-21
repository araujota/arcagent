import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import { createRoutes } from "./routes";
import { authMiddleware } from "./auth";

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------
vi.mock("../index", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
beforeAll(() => {
  process.env.WORKER_SHARED_SECRET = "test-secret";
  process.env.CONVEX_URL = "https://test.convex.cloud";
});

// ---------------------------------------------------------------------------
// Mock queue
// ---------------------------------------------------------------------------

let mockQueueAdd: ReturnType<typeof vi.fn>;

function createTestApp() {
  mockQueueAdd = vi.fn().mockResolvedValue(undefined);
  const mockQueue = { add: mockQueueAdd } as any;

  const app = express();
  app.use(express.json({ limit: "12mb" }));
  app.use(authMiddleware);
  app.use("/api", createRoutes(mockQueue));
  return app;
}

const AUTH_HEADER = "Bearer test-secret";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/verify", () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  it("returns 400 when repoUrl missing", async () => {
    const res = await supertest(app)
      .post("/api/verify")
      .set("Authorization", AUTH_HEADER)
      .send({
        submissionId: "sub_1",
        bountyId: "bounty_1",
        commitSha: "abc123",
        // repoUrl: missing
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("repoUrl");
  });

  it("returns 400 when commitSha missing", async () => {
    const res = await supertest(app)
      .post("/api/verify")
      .set("Authorization", AUTH_HEADER)
      .send({
        submissionId: "sub_1",
        bountyId: "bounty_1",
        repoUrl: "https://github.com/test/repo",
        // commitSha: missing
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("commitSha");
  });

  it("returns 400 when submissionId missing", async () => {
    const res = await supertest(app)
      .post("/api/verify")
      .set("Authorization", AUTH_HEADER)
      .send({
        bountyId: "bounty_1",
        repoUrl: "https://github.com/test/repo",
        commitSha: "abc123",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("submissionId");
  });

  it("returns 202 with jobId on valid request", async () => {
    const res = await supertest(app)
      .post("/api/verify")
      .set("Authorization", AUTH_HEADER)
      .send({
        submissionId: "sub_1",
        bountyId: "bounty_1",
        repoUrl: "https://github.com/test/repo",
        commitSha: "abc123",
      });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeDefined();
    expect(res.body.status).toBe("queued");
  });

  it("passes jobHmac through to enqueued job data", async () => {
    await supertest(app)
      .post("/api/verify")
      .set("Authorization", AUTH_HEADER)
      .send({
        submissionId: "sub_1",
        bountyId: "bounty_1",
        repoUrl: "https://github.com/test/repo",
        commitSha: "abc123",
        jobHmac: "hmac_token_123",
      });

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [, jobData] = mockQueueAdd.mock.calls[0];
    expect(jobData.jobHmac).toBe("hmac_token_123");
  });

  it("uses server CONVEX_URL, ignores client convexUrl (C4)", async () => {
    await supertest(app)
      .post("/api/verify")
      .set("Authorization", AUTH_HEADER)
      .send({
        submissionId: "sub_1",
        bountyId: "bounty_1",
        repoUrl: "https://github.com/test/repo",
        commitSha: "abc123",
        convexUrl: "https://attacker.com",
      });

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [, jobData] = mockQueueAdd.mock.calls[0];
    expect(jobData.convexUrl).toBe("https://test.convex.cloud");
  });

  it("clamps timeoutSeconds to [60, 3600]", async () => {
    // Test lower bound
    const res1 = await supertest(app)
      .post("/api/verify")
      .set("Authorization", AUTH_HEADER)
      .send({
        submissionId: "sub_1",
        bountyId: "bounty_1",
        repoUrl: "https://github.com/test/repo",
        commitSha: "abc123",
        timeoutSeconds: 10,
      });
    expect(res1.status).toBe(202);
    const [, jobData1] = mockQueueAdd.mock.calls[0];
    expect(jobData1.timeoutSeconds).toBe(60);

    // Test upper bound
    mockQueueAdd.mockClear();
    const res2 = await supertest(app)
      .post("/api/verify")
      .set("Authorization", AUTH_HEADER)
      .send({
        submissionId: "sub_2",
        bountyId: "bounty_2",
        repoUrl: "https://github.com/test/repo",
        commitSha: "abc123",
        timeoutSeconds: 9999,
      });
    expect(res2.status).toBe(202);
    const [, jobData2] = mockQueueAdd.mock.calls[0];
    expect(jobData2.timeoutSeconds).toBe(3600);
  });

  it("returns 401 without Authorization header", async () => {
    const res = await supertest(app)
      .post("/api/verify")
      .send({
        submissionId: "sub_1",
        bountyId: "bounty_1",
        repoUrl: "https://github.com/test/repo",
        commitSha: "abc123",
      });
    expect(res.status).toBe(401);
  });
});
