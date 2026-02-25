import { createHmac, randomUUID } from "node:crypto";

export interface WorkerCallbackEnvelope {
  callbackTimestampMs: number;
  callbackNonce: string;
  callbackSignature: string;
}

export function buildWorkerCallbackEnvelope(args: {
  secret: string;
  submissionId: string;
  bountyId: string;
  jobId: string;
  overallStatus: string;
  jobHmac: string;
}): WorkerCallbackEnvelope {
  const callbackTimestampMs = Date.now();
  const callbackNonce = randomUUID();
  const callbackSignature = signWorkerCallbackEnvelope({
    secret: args.secret,
    submissionId: args.submissionId,
    bountyId: args.bountyId,
    jobId: args.jobId,
    overallStatus: args.overallStatus,
    jobHmac: args.jobHmac,
    callbackTimestampMs,
    callbackNonce,
  });

  return {
    callbackTimestampMs,
    callbackNonce,
    callbackSignature,
  };
}

function signWorkerCallbackEnvelope(args: {
  secret: string;
  submissionId: string;
  bountyId: string;
  jobId: string;
  overallStatus: string;
  jobHmac: string;
  callbackTimestampMs: number;
  callbackNonce: string;
}): string {
  const data = [
    args.submissionId,
    args.bountyId,
    args.jobId,
    args.overallStatus,
    args.jobHmac,
    String(args.callbackTimestampMs),
    args.callbackNonce,
  ].join(":");

  return createHmac("sha256", args.secret).update(data).digest("hex");
}
