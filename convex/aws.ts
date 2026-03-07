"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// ---------------------------------------------------------------------------
// AWS EC2 client — dynamic require for Convex bundling (same as stripe.ts)
// ---------------------------------------------------------------------------

function getEC2Client() {
  // Dynamic import workaround for Convex bundling — AWS SDK loaded at runtime
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EC2Client } = require("@aws-sdk/client-ec2");
  const region = process.env.AWS_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS credentials not configured (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)");
  }

  return new EC2Client({
    region: region || "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
  }) as import("@aws-sdk/client-ec2").EC2Client;
}

// Tag used to identify ArcAgent worker instances
const WORKER_TAG_PREFIX = "arcagent-worker-";

// ---------------------------------------------------------------------------
// Actions — AWS API calls
// ---------------------------------------------------------------------------

/**
 * List all ArcAgent worker EC2 instances and their status.
 */
export const listWorkers = internalAction({
  args: {},
  handler: async (_ctx) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DescribeInstancesCommand } = require("@aws-sdk/client-ec2");
    const ec2 = getEC2Client();

    const command = new DescribeInstancesCommand({
      Filters: [
        {
          Name: "tag:Name",
          Values: [`${WORKER_TAG_PREFIX}*`],
        },
        {
          Name: "instance-state-name",
          Values: ["pending", "running", "stopping", "stopped"],
        },
      ],
    }) as import("@aws-sdk/client-ec2").DescribeInstancesCommand;

    const response = await ec2.send(command);

    interface EC2Instance {
      InstanceId?: string;
      State?: { Name?: string };
      PublicIpAddress?: string;
      InstanceType?: string;
      LaunchTime?: Date;
      Tags?: Array<{ Key?: string; Value?: string }>;
    }

    const workers: Array<{
      instanceId: string;
      state: string;
      publicIp: string | null;
      instanceType: string;
      name: string;
      launchTime: string | null;
    }> = [];

    for (const reservation of response.Reservations || []) {
      for (const instance of (reservation.Instances || []) as EC2Instance[]) {
        const nameTag = instance.Tags?.find(
          (t: { Key?: string; Value?: string }) => t.Key === "Name",
        );
        workers.push({
          instanceId: instance.InstanceId || "",
          state: instance.State?.Name || "unknown",
          publicIp: instance.PublicIpAddress || null,
          instanceType: instance.InstanceType || "",
          name: nameTag?.Value || "",
          launchTime: instance.LaunchTime ? instance.LaunchTime.toISOString() : null,
        });
      }
    }

    return workers;
  },
});

/**
 * Get the health status of a specific worker instance.
 */
export const getWorkerStatus = internalAction({
  args: { instanceId: v.string() },
  handler: async (_ctx, args) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DescribeInstanceStatusCommand } = require("@aws-sdk/client-ec2");
    const ec2 = getEC2Client();

    const command = new DescribeInstanceStatusCommand({
      InstanceIds: [args.instanceId],
      IncludeAllInstances: true,
    }) as import("@aws-sdk/client-ec2").DescribeInstanceStatusCommand;

    const response = await ec2.send(command);
    const status = response.InstanceStatuses?.[0];

    if (!status) {
      return { found: false, instanceId: args.instanceId };
    }

    return {
      found: true,
      instanceId: args.instanceId,
      state: status.InstanceState?.Name || "unknown",
      instanceStatus: status.InstanceStatus?.Status || "unknown",
      systemStatus: status.SystemStatus?.Status || "unknown",
    };
  },
});

/**
 * Start a stopped worker instance.
 */
export const startWorker = internalAction({
  args: { instanceId: v.string() },
  handler: async (_ctx, args) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { StartInstancesCommand } = require("@aws-sdk/client-ec2");
    const ec2 = getEC2Client();

    const command = new StartInstancesCommand({
      InstanceIds: [args.instanceId],
    }) as import("@aws-sdk/client-ec2").StartInstancesCommand;

    const response = await ec2.send(command);
    const stateChange = response.StartingInstances?.[0];

    return {
      instanceId: args.instanceId,
      previousState: stateChange?.PreviousState?.Name || "unknown",
      currentState: stateChange?.CurrentState?.Name || "unknown",
    };
  },
});

/**
 * Stop a running worker instance.
 */
export const stopWorker = internalAction({
  args: { instanceId: v.string() },
  handler: async (_ctx, args) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { StopInstancesCommand } = require("@aws-sdk/client-ec2");
    const ec2 = getEC2Client();

    const command = new StopInstancesCommand({
      InstanceIds: [args.instanceId],
    }) as import("@aws-sdk/client-ec2").StopInstancesCommand;

    const response = await ec2.send(command);
    const stateChange = response.StoppingInstances?.[0];

    return {
      instanceId: args.instanceId,
      previousState: stateChange?.PreviousState?.Name || "unknown",
      currentState: stateChange?.CurrentState?.Name || "unknown",
    };
  },
});

/**
 * Discover running workers and sync their host URLs to WORKER_API_URL.
 * Call this after starting workers or if EIPs change.
 */
export const syncWorkerUrls = internalAction({
  args: {},
  handler: async (ctx) => {
    const workers = await ctx.runAction(internal.aws.listWorkers, {});

    const runningWorkers = workers.filter(
      (w: { state: string }) => w.state === "running",
    );

    const hostUrls = runningWorkers
      .filter((w: { publicIp: string | null }) => w.publicIp)
      .map((w: { publicIp: string | null }) => `http://${w.publicIp}:3001`);

    return {
      runningCount: runningWorkers.length,
      hostUrls,
      message:
        hostUrls.length > 0
          ? `Set WORKER_API_URL to: ${hostUrls[0]}`
          : "No running workers with public IPs found",
    };
  },
});

/**
 * Health-check a worker by hitting its /health endpoint.
 * Requires WORKER_SHARED_SECRET to be set.
 */
export const healthCheckWorker = internalAction({
  args: { workerHost: v.string() },
  handler: async (_ctx, args) => {
    const workerSecret = process.env.WORKER_SHARED_SECRET;
    if (!workerSecret) {
      return { healthy: false, error: "WORKER_SHARED_SECRET not configured" };
    }

    try {
      const response = await fetch(`${args.workerHost}/health`, {
        method: "GET",
        headers: { Authorization: `Bearer ${workerSecret}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return { healthy: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json();
      return { healthy: true, data };
    } catch (err) {
      return {
        healthy: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
