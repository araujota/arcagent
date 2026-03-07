#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot, runCommand } from "../env/lib.mjs";

const region = process.env.AWS_REGION || "us-east-1";
const repositoryName = process.env.MCP_ECR_REPOSITORY || "arcagent-mcp";

function loadTfStateDefaults() {
  const statePath = path.join(repoRoot, "infra", "aws-mcp", "terraform.tfstate");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const outputs = state.outputs ?? {};
  return {
    clusterName: outputs.ecs_cluster_name?.value,
    serviceName: outputs.ecs_service_name?.value,
    publicUrl: outputs.mcp_public_url?.value,
    workerProxyUrl: outputs.worker_proxy_public_url?.value,
  };
}

function awsJson(args) {
  const { stdout } = runCommand("aws", [...args, "--region", region, "--output", "json"]);
  return JSON.parse(stdout);
}

async function expectJson(url, expectedStatus) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json, text/event-stream",
    },
  });
  assert.equal(response.status, expectedStatus, `${url} returned HTTP ${response.status}`);
  return await response.json();
}

async function main() {
  const defaults = loadTfStateDefaults();
  const clusterName =
    process.env.MCP_ECS_CLUSTER ||
    process.env.MCP_ECS_CLUSTER_NAME ||
    defaults.clusterName;
  const serviceName =
    process.env.MCP_ECS_SERVICE ||
    process.env.MCP_ECS_SERVICE_NAME ||
    defaults.serviceName;
  const publicUrl = (process.env.MCP_PUBLIC_URL || defaults.publicUrl || "").replace(/\/+$/, "");
  const workerProxyUrl = (process.env.MCP_WORKER_PROXY_URL || defaults.workerProxyUrl || "").replace(/\/+$/, "");

  if (!clusterName || !serviceName || !publicUrl || !workerProxyUrl) {
    throw new Error("Missing MCP ECS cluster/service/public URL configuration");
  }

  const servicePayload = awsJson([
    "ecs",
    "describe-services",
    "--cluster",
    clusterName,
    "--services",
    serviceName,
  ]);
  const service = servicePayload.services?.[0];
  assert.ok(service, "ECS service not found");
  assert.equal(service.status, "ACTIVE");
  assert.ok((service.runningCount ?? 0) >= 1, "No running MCP tasks");

  const taskDefinitionArn = service.taskDefinition;
  const taskDefinitionPayload = awsJson([
    "ecs",
    "describe-task-definition",
    "--task-definition",
    taskDefinitionArn,
  ]);
  const image = taskDefinitionPayload.taskDefinition?.containerDefinitions?.[0]?.image;
  assert.ok(image, "Missing MCP container image");
  assert.match(
    image,
    new RegExp(`(^|/)${repositoryName}:`),
    `MCP task image does not reference ${repositoryName}: ${image}`,
  );

  console.log(`[mcp-smoke] ECS service: ${clusterName}/${serviceName}`);
  console.log(`[mcp-smoke] Task definition: ${taskDefinitionArn}`);
  console.log(`[mcp-smoke] Image: ${image}`);

  const health = await expectJson(`${publicUrl}/health`, 200);
  assert.equal(health.status, "ok");

  const serverCard = await expectJson(`${publicUrl}/.well-known/mcp/server-card.json`, 200);
  assert.equal(serverCard.endpoints?.mcp, `${publicUrl}/mcp`);

  const protectedResponse = await fetch(`${publicUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "smoke-auth",
      method: "tools/call",
      params: {
        name: "get_my_agent_stats",
        arguments: {},
      },
    }),
  });
  const protectedBody = await protectedResponse.text();
  assert.equal(protectedResponse.status, 401);
  assert.match(protectedBody, /Missing API key/);

  const workerHealth = await expectJson(`${workerProxyUrl}/api/health`, 200);
  assert.equal(workerHealth.status, "ok");

  console.log("[mcp-smoke] /health: ok");
  console.log("[mcp-smoke] server-card: ok");
  console.log("[mcp-smoke] protected tool call without auth: rejected");
  console.log("[mcp-smoke] worker proxy /api/health: ok");
}

main().catch((error) => {
  console.error(`[mcp-smoke] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
