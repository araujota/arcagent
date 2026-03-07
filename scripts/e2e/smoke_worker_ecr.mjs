#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pullConvexEnv, pullVercelEnv, runCommand } from "../env/lib.mjs";

const region = process.env.AWS_REGION || "us-east-1";
const repositoryName = process.env.WORKER_ECR_REPOSITORY || "arcagent-worker";

function dockerAvailable() {
  const docker = runCommand("docker", ["info"], { allowFailure: true });
  return docker.status === 0;
}

function latestTaggedImage() {
  const { stdout } = runCommand("aws", [
    "ecr",
    "describe-images",
    "--repository-name",
    repositoryName,
    "--region",
    region,
    "--query",
    "sort_by(imageDetails[?length(imageTags) > `0`], & imagePushedAt)[-1].{registryId: registryId, repositoryName: repositoryName, tag: imageTags[0]}",
    "--output",
    "json",
  ]);
  const payload = JSON.parse(stdout);
  if (!payload?.registryId || !payload?.repositoryName || !payload?.tag) {
    throw new Error(`No tagged images found in ${repositoryName}`);
  }
  return `${payload.registryId}.dkr.ecr.${region}.amazonaws.com/${payload.repositoryName}:${payload.tag}`;
}

function loginToEcr(registryHost) {
  const password = runCommand("aws", [
    "ecr",
    "get-login-password",
    "--region",
    region,
  ]);
  runCommand("docker", [
    "login",
    "--username",
    "AWS",
    "--password-stdin",
    registryHost,
  ], {
    input: password.stdout,
  });
}

async function expectWorkerHealth(baseUrl) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/health`);
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `Worker health returned HTTP ${response.status}`);
  assert.equal(body.status, "ok");
}

function hostedWorkerUrl() {
  const convexEnv = pullConvexEnv({ prod: true });
  const vercelEnv = pullVercelEnv("production");
  return process.env.WORKER_API_URL || convexEnv.WORKER_API_URL || vercelEnv.WORKER_API_URL;
}

async function runContainerSmoke(image) {
  const smokeId = `arcagent-worker-smoke-${randomUUID().slice(0, 8)}`;
  const network = `${smokeId}-net`;
  const redisName = `${smokeId}-redis`;
  const workerName = `${smokeId}-worker`;
  const port = process.env.WORKER_SMOKE_PORT || "3901";

  try {
    runCommand("docker", ["network", "create", network]);
    runCommand("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      redisName,
      "--network",
      network,
      "--network-alias",
      "redis",
      "redis:7-alpine",
    ]);
    runCommand("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      workerName,
      "--network",
      network,
      "-p",
      `127.0.0.1:${port}:3001`,
      "-e",
      "WORKER_SHARED_SECRET=smoke-test-secret",
      "-e",
      "REDIS_URL=redis://redis:6379",
      "-e",
      "WORKER_EXECUTION_BACKEND=process",
      "-e",
      "NODE_ENV=production",
      image,
    ]);

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        await expectWorkerHealth(`http://127.0.0.1:${port}`);
        console.log(`[worker-smoke] ECR container health: ok (${image})`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }

    const logs = runCommand("docker", ["logs", workerName], { allowFailure: true });
    throw new Error(`Worker container failed health checks\n${logs.stdout}\n${logs.stderr}`);
  } finally {
    runCommand("docker", ["rm", "-f", workerName], { allowFailure: true });
    runCommand("docker", ["rm", "-f", redisName], { allowFailure: true });
    runCommand("docker", ["network", "rm", network], { allowFailure: true });
  }
}

async function main() {
  const workerUrl = hostedWorkerUrl();
  if (!workerUrl) {
    throw new Error("Missing WORKER_API_URL in process env, Convex prod, and Vercel production");
  }

  await expectWorkerHealth(workerUrl);
  console.log(`[worker-smoke] Hosted worker /api/health: ok (${workerUrl})`);

  const image = latestTaggedImage();
  console.log(`[worker-smoke] Latest tagged ECR image: ${image}`);

  if (!dockerAvailable()) {
    console.log("[worker-smoke] Docker unavailable; skipped local ECR container smoke (required in CI/release only)");
    return;
  }

  loginToEcr(image.split("/")[0]);
  await runContainerSmoke(image);
}

main().catch((error) => {
  console.error(`[worker-smoke] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
