const DEFAULT_RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface FetchWithRetryOptions {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  shouldRetryStatus?: (status: number) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetriableHttpStatus(status: number): boolean {
  return DEFAULT_RETRYABLE_STATUSES.has(status);
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: FetchWithRetryOptions,
): Promise<Response> {
  const attempts = Math.max(1, options?.attempts ?? 3);
  const initialDelayMs = Math.max(0, options?.initialDelayMs ?? 250);
  const maxDelayMs = Math.max(initialDelayMs, options?.maxDelayMs ?? 2_000);
  const shouldRetryStatus = options?.shouldRetryStatus ?? isRetriableHttpStatus;

  let delayMs = initialDelayMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (attempt < attempts && shouldRetryStatus(response.status)) {
        await sleep(delayMs);
        delayMs = Math.min(maxDelayMs, Math.max(1, delayMs * 2));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) throw error;
      await sleep(delayMs);
      delayMs = Math.min(maxDelayMs, Math.max(1, delayMs * 2));
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error("fetchWithRetry failed unexpectedly");
}
