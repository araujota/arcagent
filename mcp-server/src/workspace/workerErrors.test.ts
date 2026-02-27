import { describe, expect, it } from "vitest";
import { WorkerHttpError } from "../worker/client";
import { isMissingWorkspaceSessionError } from "./workerErrors";

describe("isMissingWorkspaceSessionError", () => {
  it("matches worker 404 workspace-missing errors", () => {
    const err = new WorkerHttpError(
      404,
      "/api/workspace/exec",
      "Workspace not found or not ready",
    );
    expect(isMissingWorkspaceSessionError(err)).toBe(true);
  });

  it("does not match non-404 worker errors", () => {
    const err = new WorkerHttpError(500, "/api/workspace/exec", "Internal error");
    expect(isMissingWorkspaceSessionError(err)).toBe(false);
  });
});
