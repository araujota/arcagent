export interface Env {
  EXECUTION_API_BASE_URL: string;
  WORKER_SHARED_SECRET: string;
  FORWARD_AUTH_HEADER?: string;
}

function must(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required Cloudflare Worker var/secret: ${name}`);
  return value;
}

function trimTrailingSlash(input: string): string {
  return input.replace(/\/+$/, "");
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

function buildUpstreamUrl(request: Request, baseUrl: string): URL {
  const incoming = new URL(request.url);
  const upstream = new URL(trimTrailingSlash(baseUrl) + incoming.pathname + incoming.search);
  return upstream;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sharedSecret = must(env.WORKER_SHARED_SECRET, "WORKER_SHARED_SECRET");
    const expectedAuth = `Bearer ${sharedSecret}`;
    const authHeader = request.headers.get("authorization");
    const isHealth = request.url.endsWith("/api/health");

    // Keep health checks public; enforce auth for all other endpoints.
    if (!isHealth && authHeader !== expectedAuth) {
      return unauthorized();
    }

    const upstreamBase = must(env.EXECUTION_API_BASE_URL, "EXECUTION_API_BASE_URL");
    const upstreamUrl = buildUpstreamUrl(request, upstreamBase);
    const headers = new Headers(request.headers);

    // Always forward the canonical shared-secret auth to the execution worker.
    headers.set("authorization", expectedAuth);

    if (env.FORWARD_AUTH_HEADER && authHeader) {
      headers.set(env.FORWARD_AUTH_HEADER, authHeader);
    }

    return fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "follow",
    });
  }
};
