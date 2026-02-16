/**
 * Direct HTTP client for workspace operations on the worker.
 *
 * Bypasses Convex for latency-sensitive interactive operations
 * (exec, file read/write). Auth: WORKER_SHARED_SECRET bearer token.
 */

let workerSecret: string;

const DEFAULT_TIMEOUT_MS = 130_000; // slightly over max command timeout

export function initWorkerClient(secret: string): void {
  workerSecret = secret;
}

export async function callWorker<T = unknown>(
  workerHost: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const url = `${workerHost.replace(/\/+$/, "")}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerSecret}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const rawText = await response.text().catch(() => "");
      let errorMessage: string;
      try {
        const parsed = JSON.parse(rawText);
        errorMessage = parsed.error || parsed.message || rawText.slice(0, 200);
      } catch {
        errorMessage = `Worker error (${response.status}). ${rawText.slice(0, 200)}`;
      }
      throw new Error(errorMessage);
    }

    return (await response.json()) as T;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Worker request timed out: ${path}`);
    }
    throw err;
  }
}
