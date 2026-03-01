export interface TelemetrySnapshot {
  requestsTotal: number;
  authFailures: number;
  rateLimited: number;
  registerAttempts: number;
  registerSuccesses: number;
  registerFailures: number;
  registerRateLimited: number;
  toolRequests: number;
  toolFailures: number;
  activeSessions: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  toolP50Ms: number;
  toolP95Ms: number;
  toolP99Ms: number;
}

export class HttpTelemetry {
  private requestsTotal = 0;
  private authFailures = 0;
  private rateLimited = 0;
  private registerAttempts = 0;
  private registerSuccesses = 0;
  private registerFailures = 0;
  private registerRateLimited = 0;
  private toolRequests = 0;
  private toolFailures = 0;
  private latencies: number[] = [];
  private toolLatencies: number[] = [];
  private readonly maxSamples = 2000;

  recordRequest(durationMs: number): void {
    this.requestsTotal += 1;
    this.latencies.push(durationMs);
    if (this.latencies.length > this.maxSamples) {
      this.latencies.shift();
    }
  }

  recordAuthFailure(): void {
    this.authFailures += 1;
  }

  recordRateLimited(): void {
    this.rateLimited += 1;
  }

  recordRegisterAttempt(): void {
    this.registerAttempts += 1;
  }

  recordRegisterSuccess(): void {
    this.registerSuccesses += 1;
  }

  recordRegisterFailure(): void {
    this.registerFailures += 1;
  }

  recordRegisterRateLimited(): void {
    this.registerRateLimited += 1;
  }

  recordToolRequest(durationMs: number, success: boolean): void {
    this.toolRequests += 1;
    if (!success) this.toolFailures += 1;
    this.toolLatencies.push(durationMs);
    if (this.toolLatencies.length > this.maxSamples) {
      this.toolLatencies.shift();
    }
  }

  private pickPercentile(latencies: number[], percentile: number): number {
    const sorted = [...latencies].sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const idx = Math.min(
      sorted.length - 1,
      Math.floor((percentile / 100) * sorted.length),
    );
    return sorted[idx];
  }

  snapshot(activeSessions: number): TelemetrySnapshot {
    return {
      requestsTotal: this.requestsTotal,
      authFailures: this.authFailures,
      rateLimited: this.rateLimited,
      registerAttempts: this.registerAttempts,
      registerSuccesses: this.registerSuccesses,
      registerFailures: this.registerFailures,
      registerRateLimited: this.registerRateLimited,
      toolRequests: this.toolRequests,
      toolFailures: this.toolFailures,
      activeSessions,
      p50Ms: this.pickPercentile(this.latencies, 50),
      p95Ms: this.pickPercentile(this.latencies, 95),
      p99Ms: this.pickPercentile(this.latencies, 99),
      toolP50Ms: this.pickPercentile(this.toolLatencies, 50),
      toolP95Ms: this.pickPercentile(this.toolLatencies, 95),
      toolP99Ms: this.pickPercentile(this.toolLatencies, 99),
    };
  }
}
