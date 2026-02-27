/**
 * SNI-based HTTPS egress proxy for Firecracker microVMs.
 *
 * Uses Squid in transparent proxy mode with `ssl_bump peek` to inspect the
 * TLS ClientHello SNI field without performing MITM. Allowed domains are
 * spliced through; everything else is terminated.
 *
 * Rate limiting via `tc qdisc` and connection limits via `connlimit` provide
 * additional defense against exfiltration.
 */

import { readFile, writeFile, unlink } from "node:fs/promises";
import { logger } from "../index";
import { execFileAsync } from "../lib/execFileAsync";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EgressProxyHandle {
  vmId: string;
  configPath: string;
  pidFile: string;
  port: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base port for per-VM Squid instances. Port = BASE + hash(vmId) % 1000. */
const PROXY_PORT_BASE = 13000;
const PROXY_START_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start an SNI-based HTTPS proxy for a specific VM.
 *
 * @param vmId - VM identifier
 * @param allowedDomains - Domains to allow (exact or wildcard like "*.npmjs.org")
 * @returns Handle for cleanup
 */
export async function startEgressProxy(
  vmId: string,
  allowedDomains: string[],
): Promise<EgressProxyHandle> {
  const port = allocateProxyPort(vmId);
  const configPath = `/tmp/fc-proxy-${vmId}.conf`;
  const pidFile = `/tmp/fc-proxy-${vmId}.pid`;

  // Build Squid config for SNI-based filtering
  const aclLines = allowedDomains.map((domain, i) => {
    if (domain.startsWith("*.")) {
      return `acl allowed_domain_${i} ssl::server_name_regex \\.${escapeRegex(domain.slice(2))}$`;
    }
    return `acl allowed_domain_${i} ssl::server_name ${domain}`;
  });

  const orConditions = allowedDomains.map((_, i) => `allowed_domain_${i}`).join(" ");

  const config = `
# Auto-generated Squid config for ${vmId}
http_port ${port} transparent ssl-bump cert=/etc/squid/ssl_cert/myCA-combined.pem generate-host-certificates=on dynamic_cert_mem_cache_size=4MB
pid_filename ${pidFile}

# SNI-based ACLs
${aclLines.join("\n")}
acl step1 at_step SslBump1

# Peek at ClientHello to read SNI
ssl_bump peek step1

# Splice (pass through) allowed domains
ssl_bump splice ${orConditions}

# Terminate everything else
ssl_bump terminate all

# Access controls
http_access allow ${orConditions}
http_access deny all

# Logging
access_log /tmp/fc-proxy-${vmId}.log
cache_log /tmp/fc-proxy-${vmId}-cache.log

# Performance
cache deny all
dns_nameservers 127.0.0.1
`;

  await writeFile(configPath, config);

  await execFileAsync("squid", ["-k", "parse", "-f", configPath], { timeout: 5_000 });
  await execFileAsync("squid", ["-f", configPath], { timeout: 5_000 });
  await waitForPidFile(pidFile, PROXY_START_TIMEOUT_MS);

  logger.info("Egress proxy started", { vmId, port, domains: allowedDomains.length });

  return { vmId, configPath, pidFile, port };
}

/**
 * Stop the egress proxy and clean up.
 */
export async function stopEgressProxy(handle: EgressProxyHandle): Promise<void> {
  try {
    const pid = (await readFile(handle.pidFile, "utf-8")).trim();
    if (pid) {
      process.kill(parseInt(pid, 10), "SIGTERM");
    }
  } catch {
    // Process may already be stopped
  }

  await unlink(handle.configPath).catch(() => {});
  await unlink(handle.pidFile).catch(() => {});
  await unlink(`/tmp/fc-proxy-${handle.vmId}.log`).catch(() => {});
  await unlink(`/tmp/fc-proxy-${handle.vmId}-cache.log`).catch(() => {});

  logger.info("Egress proxy stopped", { vmId: handle.vmId });
}

/**
 * Apply iptables REDIRECT to route VM HTTPS traffic through the proxy.
 */
export async function applyProxyRedirect(
  tapDevice: string,
  proxyPort: number,
): Promise<void> {
  // Redirect HTTPS (443) through the proxy
  await execFileAsync("iptables", [
    "-t", "nat", "-A", "PREROUTING",
    "-i", tapDevice,
    "-p", "tcp", "--dport", "443",
    "-j", "REDIRECT", "--to-port", String(proxyPort),
  ]);
}

/**
 * Remove proxy redirect rules.
 */
export async function removeProxyRedirect(
  tapDevice: string,
  proxyPort: number,
): Promise<void> {
  await execFileAsync("iptables", [
    "-t", "nat", "-D", "PREROUTING",
    "-i", tapDevice,
    "-p", "tcp", "--dport", "443",
    "-j", "REDIRECT", "--to-port", String(proxyPort),
  ]).catch(() => {});
}

/**
 * Apply rate limiting and connection limits on a TAP device.
 */
export async function applyRateLimiting(tapDevice: string): Promise<void> {
  // tc qdisc: 10mbit rate limit with burst
  await execFileAsync("tc", [
    "qdisc", "add", "dev", tapDevice, "root", "tbf",
    "rate", "10mbit", "burst", "32kbit", "latency", "400ms",
  ]);

  // connlimit: max 50 concurrent outbound connections
  await execFileAsync("iptables", [
    "-A", "FORWARD",
    "-i", tapDevice,
    "-p", "tcp", "--syn",
    "-m", "connlimit", "--connlimit-above", "50",
    "-j", "DROP",
  ]);
}

/**
 * Remove rate limiting rules.
 */
export async function removeRateLimiting(tapDevice: string): Promise<void> {
  await execFileAsync("tc", [
    "qdisc", "del", "dev", tapDevice, "root",
  ]).catch(() => {});

  await execFileAsync("iptables", [
    "-D", "FORWARD",
    "-i", tapDevice,
    "-p", "tcp", "--syn",
    "-m", "connlimit", "--connlimit-above", "50",
    "-j", "DROP",
  ]).catch(() => {});
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function allocateProxyPort(vmId: string): number {
  let hash = 0;
  for (const ch of vmId) {
    hash = (hash * 31 + ch.charCodeAt(0)) & 0xffffffff;
  }
  return PROXY_PORT_BASE + (Math.abs(hash) % 1000);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForPidFile(pidFile: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pidText = (await readFile(pidFile, "utf8")).trim();
      if (pidText) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for proxy pid file: ${pidFile}`);
}
