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
      const rawText = await response.text().catch(() => "");
      // Try to extract a structured error message from Convex JSON responses
      let errorMessage: string;
      try {
        const parsed = JSON.parse(rawText);
        errorMessage = parsed.message || parsed.error || rawText.slice(0, 200);
      } catch {
        // Non-JSON response (e.g. HTML error page from 502/503)
        if (response.status === 401 || response.status === 403) {
          errorMessage = "Authentication failed. Check your API key.";
        } else {
          errorMessage = `Server error (${response.status}). Please retry.`;
        }
      }
      throw new Error(errorMessage);
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
