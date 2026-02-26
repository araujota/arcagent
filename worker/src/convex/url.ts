const CLOUD_SUFFIX = ".convex.cloud";
const SITE_SUFFIX = ".convex.site";

/**
 * Convert a Convex deployment URL to its HTTP-actions base URL.
 * Convex HTTP actions are served from *.convex.site.
 */
export function toConvexHttpActionsBaseUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname.endsWith(CLOUD_SUFFIX)) {
    parsed.hostname = `${parsed.hostname.slice(0, -CLOUD_SUFFIX.length)}${SITE_SUFFIX}`;
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * Resolve the configured Convex HTTP-actions URL from environment.
 * Falls back to CONVEX_URL for backward compatibility.
 */
export function resolveConfiguredConvexHttpActionsUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.CONVEX_HTTP_ACTIONS_URL || env.CONVEX_URL;
  if (!raw) return undefined;
  return toConvexHttpActionsBaseUrl(raw);
}
