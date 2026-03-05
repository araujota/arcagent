"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import {
  deriveAttemptServiceToken,
  deriveAttemptServiceTokenHash,
  deriveAttemptTokenSigningSecret,
} from "./lib/attemptWorkerAuth";

type AttemptWorkerRecord = Doc<"attemptWorkers">;

function getEc2Client() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EC2Client } = require("@aws-sdk/client-ec2") as typeof import("@aws-sdk/client-ec2");
  const region = process.env.ATTEMPT_WORKER_AWS_REGION || process.env.AWS_REGION || "us-east-1";
  return new EC2Client({ region });
}

function getRoute53Client() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Route53Client } = require("@aws-sdk/client-route-53") as typeof import("@aws-sdk/client-route-53");
  return new Route53Client({});
}

function getLaunchTemplateConfig(): { launchTemplateId?: string; launchTemplateName?: string } {
  const launchTemplateId = process.env.ATTEMPT_WORKER_LAUNCH_TEMPLATE_ID;
  const launchTemplateName = process.env.ATTEMPT_WORKER_LAUNCH_TEMPLATE_NAME;
  if (!launchTemplateId && !launchTemplateName) {
    throw new Error(
      "ATTEMPT_WORKER_LAUNCH_TEMPLATE_ID or ATTEMPT_WORKER_LAUNCH_TEMPLATE_NAME must be configured",
    );
  }
  return { launchTemplateId, launchTemplateName };
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = (process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes";
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function toBase64(input: string): string {
  return Buffer.from(input, "utf-8").toString("base64");
}

function sanitizeDnsLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 50);
}

function buildAttemptBootstrapScript(params: {
  serviceToken: string;
  tokenSigningSecret: string;
  convexUrl: string;
  convexHttpActionsUrl: string;
  workspaceIsolationMode: "dedicated_attempt_vm";
}): string {
  const execBackend = process.env.ATTEMPT_WORKER_EXECUTION_BACKEND ?? "process";
  const hostUrlLocked = "false";
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "LOG_FILE=/var/log/arcagent-attempt-bootstrap.log",
    "exec > >(tee -a \"$LOG_FILE\") 2>&1",
    "echo \"=== Attempt worker bootstrap start $(date -u) ===\"",
    "mkdir -p /opt/arcagent",
    "touch /opt/arcagent/worker.env",
    "id -u agent >/dev/null 2>&1 || useradd -m -s /bin/bash agent",
    "iptables -C OUTPUT -m owner --uid-owner agent -d 169.254.169.254/32 -j REJECT 2>/dev/null || iptables -A OUTPUT -m owner --uid-owner agent -d 169.254.169.254/32 -j REJECT",
    "sed -i '/^WORKER_SHARED_SECRET=/d' /opt/arcagent/worker.env || true",
    "sed -i '/^WORKER_TOKEN_SIGNING_SECRET=/d' /opt/arcagent/worker.env || true",
    "sed -i '/^WORKER_EXECUTION_BACKEND=/d' /opt/arcagent/worker.env || true",
    "sed -i '/^WORKSPACE_ISOLATION_MODE=/d' /opt/arcagent/worker.env || true",
    "sed -i '/^PROCESS_BACKEND_EXEC_USER=/d' /opt/arcagent/worker.env || true",
    "sed -i '/^MAX_DEV_VMS=/d' /opt/arcagent/worker.env || true",
    "sed -i '/^WARM_POOL_SIZE=/d' /opt/arcagent/worker.env || true",
    "sed -i '/^MAX_WARM_VMS=/d' /opt/arcagent/worker.env || true",
    "sed -i '/^WORKER_CONCURRENCY=/d' /opt/arcagent/worker.env || true",
    "sed -i '/^FC_USE_VSOCK=/d' /opt/arcagent/worker.env || true",
    "sed -i '/^FC_VALIDATE_VSOCK_ROOTFS=/d' /opt/arcagent/worker.env || true",
    "sed -i '/^FC_HARDEN_EGRESS=/d' /opt/arcagent/worker.env || true",
    "sed -i '/^WORKER_HOST_URL_LOCKED=/d' /opt/arcagent/worker.env || true",
    "cat >> /opt/arcagent/worker.env <<'EOF'",
    `WORKER_SHARED_SECRET=${params.serviceToken}`,
    `WORKER_TOKEN_SIGNING_SECRET=${params.tokenSigningSecret}`,
    `CONVEX_URL=${params.convexUrl}`,
    `CONVEX_HTTP_ACTIONS_URL=${params.convexHttpActionsUrl}`,
    `WORKER_EXECUTION_BACKEND=${execBackend}`,
    `WORKSPACE_ISOLATION_MODE=${params.workspaceIsolationMode}`,
    "PROCESS_BACKEND_EXEC_USER=agent",
    "MAX_DEV_VMS=1",
    "WARM_POOL_SIZE=0",
    "MAX_WARM_VMS=0",
    "WORKER_CONCURRENCY=1",
    "FC_USE_VSOCK=false",
    "FC_VALIDATE_VSOCK_ROOTFS=false",
    "FC_HARDEN_EGRESS=false",
    `WORKER_HOST_URL_LOCKED=${hostUrlLocked}`,
    "EOF",
    "chmod 600 /opt/arcagent/worker.env || true",
    "systemctl daemon-reload || true",
    "systemctl restart arcagent-worker",
    "systemctl is-active arcagent-worker --quiet",
    "echo \"=== Attempt worker bootstrap done $(date -u) ===\"",
  ];
  return lines.join("\n");
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeConsoleOutput(output?: string): string {
  return output
    ? Buffer.from(output, "base64").toString("utf-8").slice(-8_000)
    : "No console output available";
}

async function fetchConsoleBootLog(
  ec2: { send: (command: unknown) => Promise<{ Output?: string }> },
  GetConsoleOutputCommand: new (args: { InstanceId: string; Latest: true }) => unknown,
  instanceId: string,
): Promise<string> {
  const consoleOut = await ec2
    .send(new GetConsoleOutputCommand({ InstanceId: instanceId, Latest: true }))
    .catch(() => null);
  return decodeConsoleOutput(consoleOut?.Output);
}

async function markAttemptWorkerError(
  ctx: { runMutation: (mutation: unknown, payload: Record<string, unknown>) => Promise<unknown> },
  args: { attemptWorkerId: unknown },
  errorMessage: string,
  bootLog: string,
  publicHost?: string,
): Promise<void> {
  await ctx.runMutation(internal.attemptWorkers.update, {
    attemptWorkerId: args.attemptWorkerId,
    status: "error",
    errorMessage,
    bootLogRef: bootLog,
    ...(publicHost ? { publicHost } : {}),
  });
}

function buildPublicHost(protocol: string, fqdn: string, publicPort: number): string {
  const needsPort =
    (protocol === "http" && publicPort !== 80) || (protocol === "https" && publicPort !== 443);
  const portSuffix = needsPort ? `:${publicPort}` : "";
  return `${protocol}://${fqdn}${portSuffix}`;
}

async function waitForRunningInstance(args: {
  ec2: { send: (command: unknown) => Promise<any> };
  DescribeInstancesCommand: new (input: { InstanceIds: string[] }) => unknown;
  instanceId: string;
  attemptWorkerId: unknown;
  ctx: { runMutation: (mutation: unknown, payload: Record<string, unknown>) => Promise<unknown> };
  deadline: number;
  pollMs: number;
}): Promise<string> {
  while (Date.now() < args.deadline) {
    const desc = await args.ec2.send(new args.DescribeInstancesCommand({ InstanceIds: [args.instanceId] }));
    const instance = desc.Reservations?.[0]?.Instances?.[0];
    const state = instance?.State?.Name ?? "unknown";
    const currentPublicIp = instance?.PublicIpAddress ?? "";

    if (state === "running" && currentPublicIp) {
      await args.ctx.runMutation(internal.attemptWorkers.update, {
        attemptWorkerId: args.attemptWorkerId,
        status: "running",
        runningAt: Date.now(),
        instanceId: args.instanceId,
      });
      return currentPublicIp;
    }

    await wait(args.pollMs);
  }
  return "";
}

async function waitForWorkerHealth(controlHost: string, deadline: number, pollMs: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${controlHost}/api/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // keep polling
    }
    await wait(pollMs);
  }
  return false;
}

export const awaitHealthy = internalAction({
  args: {
    attemptWorkerId: v.id("attemptWorkers"),
    workspaceId: v.string(),
    instanceId: v.string(),
  },
  handler: async (ctx, args) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DescribeInstancesCommand, GetConsoleOutputCommand } = require("@aws-sdk/client-ec2") as typeof import("@aws-sdk/client-ec2");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ChangeResourceRecordSetsCommand } = require("@aws-sdk/client-route-53") as typeof import("@aws-sdk/client-route-53");
    const ec2 = getEc2Client();

    const healthTimeoutMs = Number.parseInt(process.env.ATTEMPT_WORKER_HEALTH_TIMEOUT_MS ?? "240000", 10);
    const pollMs = Number.parseInt(process.env.ATTEMPT_WORKER_HEALTH_POLL_MS ?? "5000", 10);
    const deadline = Date.now() + Math.max(30_000, healthTimeoutMs);
    const publishDns = boolEnv("ATTEMPT_WORKER_PUBLISH_DNS_HOST", false);
    const protocol = (process.env.ATTEMPT_WORKER_PUBLIC_PROTOCOL ?? "http").toLowerCase();
    const publicPort = Number.parseInt(process.env.ATTEMPT_WORKER_PUBLIC_PORT ?? "3001", 10);
    const dnsZoneId = process.env.ATTEMPT_WORKER_ROUTE53_ZONE_ID ?? "";
    const baseDomain = (process.env.ATTEMPT_WORKER_BASE_DOMAIN ?? "").trim().replace(/\.$/, "");

    const publicIp = await waitForRunningInstance({
      ec2,
      DescribeInstancesCommand,
      instanceId: args.instanceId,
      attemptWorkerId: args.attemptWorkerId,
      ctx,
      deadline,
      pollMs,
    });

    if (!publicIp) {
      const bootLog = await fetchConsoleBootLog(ec2, GetConsoleOutputCommand, args.instanceId);
      await markAttemptWorkerError(
        ctx,
        args,
        "Attempt worker did not reach running state with public IP before timeout",
        bootLog,
      );
      throw new Error("Attempt worker failed to reach running state");
    }

    const controlHost = `http://${publicIp}:3001`;
    let publicHost = controlHost;

    if (publishDns && dnsZoneId && baseDomain) {
      const route53 = getRoute53Client();
      const label = sanitizeDnsLabel(args.workspaceId);
      const fqdn = `${label}.${baseDomain}`;
      await route53.send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: dnsZoneId,
          ChangeBatch: {
            Comment: `ArcAgent attempt worker ${args.instanceId}`,
            Changes: [
              {
                Action: "UPSERT",
                ResourceRecordSet: {
                  Name: fqdn,
                  Type: "A",
                  TTL: Number.parseInt(process.env.ATTEMPT_WORKER_DNS_TTL ?? "60", 10),
                  ResourceRecords: [{ Value: publicIp }],
                },
              },
            ],
          },
        }),
      );
      publicHost = buildPublicHost(protocol, fqdn, publicPort);
    }

    const healthy = await waitForWorkerHealth(controlHost, deadline, pollMs);
    if (healthy) {
      await ctx.runMutation(internal.attemptWorkers.update, {
        attemptWorkerId: args.attemptWorkerId,
        status: "healthy",
        healthyAt: Date.now(),
        publicHost,
      });
      return { controlHost, publicHost };
    }

    const bootLog = await fetchConsoleBootLog(ec2, GetConsoleOutputCommand, args.instanceId);
    await markAttemptWorkerError(ctx, args, "Attempt worker failed health checks before timeout", bootLog, publicHost);
    throw new Error("Attempt worker failed health checks before timeout");
  },
});

export const launchForWorkspace = internalAction({
  args: {
    claimId: v.id("bountyClaims"),
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
    workspaceId: v.string(),
  },
  handler: async (ctx, args) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RunInstancesCommand } = require("@aws-sdk/client-ec2") as typeof import("@aws-sdk/client-ec2");
    const ec2 = getEc2Client();

    const existing = await ctx.runQuery(internal.attemptWorkers.getByClaim, {
      claimId: args.claimId,
    });
    if (existing && existing.status !== "terminated" && existing.status !== "error") {
      const serviceToken = await deriveAttemptServiceToken(existing.tokenSigningKeyId);
      const tokenSigningSecret = await deriveAttemptTokenSigningSecret(existing.tokenSigningKeyId);

      if (existing.publicHost && (existing.status === "healthy" || existing.status === "ready")) {
        return {
          attemptWorkerId: existing._id,
          status: existing.status,
          instanceId: existing.instanceId,
          publicHost: existing.publicHost,
          controlHost: existing.publicHost,
          serviceToken,
          tokenSigningSecret,
        };
      }

      if (existing.instanceId) {
        const healthy = await ctx.runAction(internal.attemptWorkersNode.awaitHealthy, {
          attemptWorkerId: existing._id,
          workspaceId: args.workspaceId,
          instanceId: existing.instanceId,
        });
        return {
          attemptWorkerId: existing._id,
          instanceId: existing.instanceId,
          status: "healthy" as const,
          publicHost: healthy.publicHost,
          controlHost: healthy.controlHost,
          serviceToken,
          tokenSigningSecret,
        };
      }
    }

    const tokenSigningKeyId = crypto.randomUUID();
    const serviceTokenHash = await deriveAttemptServiceTokenHash(tokenSigningKeyId);
    const serviceToken = await deriveAttemptServiceToken(tokenSigningKeyId);
    const tokenSigningSecret = await deriveAttemptTokenSigningSecret(tokenSigningKeyId);

    const attemptWorkerId = await ctx.runMutation(internal.attemptWorkers.create, {
      claimId: args.claimId,
      bountyId: args.bountyId,
      agentId: args.agentId,
      workspaceId: args.workspaceId,
      serviceTokenHash,
      tokenSigningKeyId,
      mode: "dedicated_attempt_vm",
    });

    const { launchTemplateId, launchTemplateName } = getLaunchTemplateConfig();
    const subnetId = process.env.ATTEMPT_WORKER_SUBNET_ID;
    const securityGroupIds = parseCsv(process.env.ATTEMPT_WORKER_SECURITY_GROUP_IDS);
    const instanceType = process.env
      .ATTEMPT_WORKER_INSTANCE_TYPE as import("@aws-sdk/client-ec2").InstanceType | undefined;
    const keyName = process.env.ATTEMPT_WORKER_KEY_NAME;
    const convexUrl = process.env.CONVEX_URL ?? "";
    const convexHttpActionsUrl = process.env.CONVEX_HTTP_ACTIONS_URL ?? convexUrl;

    if (!convexUrl) {
      throw new Error("CONVEX_URL must be configured for attempt worker bootstrapping");
    }

    const userData = buildAttemptBootstrapScript({
      serviceToken,
      tokenSigningSecret,
      convexUrl,
      convexHttpActionsUrl,
      workspaceIsolationMode: "dedicated_attempt_vm",
    });

    const runResult = await ec2.send(
      new RunInstancesCommand({
        MinCount: 1,
        MaxCount: 1,
        LaunchTemplate: launchTemplateId
          ? { LaunchTemplateId: launchTemplateId }
          : { LaunchTemplateName: launchTemplateName! },
        InstanceType: instanceType,
        KeyName: keyName,
        SubnetId: subnetId,
        SecurityGroupIds: securityGroupIds.length > 0 ? securityGroupIds : undefined,
        UserData: toBase64(userData),
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: [
              { Key: "Name", Value: `arcagent-attempt-${args.workspaceId}` },
              { Key: "ArcAgentAttemptWorkerId", Value: String(attemptWorkerId) },
              { Key: "ArcAgentWorkspaceId", Value: args.workspaceId },
              { Key: "ArcAgentClaimId", Value: String(args.claimId) },
              { Key: "ArcAgentBountyId", Value: String(args.bountyId) },
            ],
          },
        ],
      }),
    );

    const instanceId = runResult.Instances?.[0]?.InstanceId;
    if (!instanceId) {
      await ctx.runMutation(internal.attemptWorkers.update, {
        attemptWorkerId,
        status: "error",
        errorMessage: "RunInstances returned no instance ID",
      });
      throw new Error("Attempt worker launch failed: no instance ID");
    }

    await ctx.runMutation(internal.attemptWorkers.update, {
      attemptWorkerId,
      instanceId,
      status: "launching",
      bootLogRef: `ec2-console:${instanceId}`,
    });

    const healthy = await ctx.runAction(internal.attemptWorkersNode.awaitHealthy, {
      attemptWorkerId,
      workspaceId: args.workspaceId,
      instanceId,
    });

    return {
      attemptWorkerId,
      instanceId,
      status: "healthy" as const,
      publicHost: healthy.publicHost,
      controlHost: healthy.controlHost,
      serviceToken,
      tokenSigningSecret,
    };
  },
});

export const terminate = internalAction({
  args: {
    attemptWorkerId: v.id("attemptWorkers"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TerminateInstancesCommand } = require("@aws-sdk/client-ec2") as typeof import("@aws-sdk/client-ec2");

    const attempt = await ctx.runQuery(internal.attemptWorkers.getByIdInternal, {
      attemptWorkerId: args.attemptWorkerId,
    }) as AttemptWorkerRecord | null;
    if (!attempt) return { terminated: false, reason: "not_found" };
    if (attempt.status === "terminated") return { terminated: true, reason: "already_terminated" };

    await ctx.runMutation(internal.attemptWorkers.update, {
      attemptWorkerId: args.attemptWorkerId,
      status: "terminating",
      terminateReason: args.reason,
    });

    const ec2 = getEc2Client();
    if (attempt.instanceId) {
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: [attempt.instanceId] })).catch(() => undefined);
    }

    await ctx.runMutation(internal.attemptWorkers.update, {
      attemptWorkerId: args.attemptWorkerId,
      status: "terminated",
      terminatedAt: Date.now(),
      terminateReason: args.reason,
    });

    return { terminated: true, reason: args.reason };
  },
});

export const getStartupLog = internalAction({
  args: {
    attemptWorkerId: v.id("attemptWorkers"),
  },
  handler: async (ctx, args) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { GetConsoleOutputCommand } = require("@aws-sdk/client-ec2") as typeof import("@aws-sdk/client-ec2");
    const ec2 = getEc2Client();

    const row = await ctx.runQuery(internal.attemptWorkers.getByIdInternal, {
      attemptWorkerId: args.attemptWorkerId,
    }) as AttemptWorkerRecord | null;
    if (!row) {
      return { found: false, message: "Attempt worker not found", bootLogRef: null, log: "" };
    }
    if (!row.instanceId) {
      return {
        found: true,
        message: "Attempt worker has no instance ID yet",
        bootLogRef: row.bootLogRef ?? null,
        log: row.errorMessage ?? "",
      };
    }

    const output = await ec2
      .send(new GetConsoleOutputCommand({ InstanceId: row.instanceId, Latest: true }))
      .catch(() => null);
    const raw = output?.Output ? Buffer.from(output.Output, "base64").toString("utf-8") : "";
    const maxLines = parseInt(process.env.ATTEMPT_WORKER_BOOT_LOG_LINES ?? "200", 10);
    const trimmed = raw.split("\n").slice(-Math.max(1, maxLines)).join("\n");

    return {
      found: true,
      message: row.status,
      bootLogRef: row.bootLogRef ?? null,
      log: trimmed,
      instanceId: row.instanceId,
      publicHost: row.publicHost ?? null,
      status: row.status,
      launchRequestedAt: row.launchRequestedAt,
      runningAt: row.runningAt ?? null,
      healthyAt: row.healthyAt ?? null,
      terminatedAt: row.terminatedAt ?? null,
      errorMessage: row.errorMessage ?? null,
    };
  },
});
