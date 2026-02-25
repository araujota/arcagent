export interface TelemetrySnapshot {
  requestsTotal: number;
  authFailures: number;
  rateLimited: number;
  activeSessions: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export class HttpTelemetry {
  private requestsTotal = 0;
  private authFailures = 0;
  private rateLimited = 0;
  private latencies: number[] = [];
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

  snapshot(activeSessions: number): TelemetrySnapshot {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const pick = (percentile: number): number => {
      if (sorted.length === 0) return 0;
      const idx = Math.min(
        sorted.length - 1,
        Math.floor((percentile / 100) * sorted.length),
      );
      return sorted[idx];
    };

    return {
      requestsTotal: this.requestsTotal,
      authFailures: this.authFailures,
      rateLimited: this.rateLimited,
      activeSessions,
      p50Ms: pick(50),
      p95Ms: pick(95),
      p99Ms: pick(99),
    };
  }
}
