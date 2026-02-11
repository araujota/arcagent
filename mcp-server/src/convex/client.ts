/**
 * HTTP client for calling Convex internal endpoints.
 * All calls are authenticated with MCP_SHARED_SECRET.
 */

const REQUEST_TIMEOUT_MS = 15_000;

let convexUrl: string;
let sharedSecret: string;

export function initConvexClient(url: string, secret: string): void {
  convexUrl = url.replace(/\/+$/, "");
  sharedSecret = secret;
}

export async function callConvex<T = unknown>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = `${convexUrl}${path}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sharedSecret}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Convex HTTP ${response.status}: ${text.slice(0, 200)}`
      );
    }

    return (await response.json()) as T;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Convex request timed out: ${path}`);
    }
    throw err;
  }
}
