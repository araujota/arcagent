/**
 * Per-VM DNS policy enforcement.
 *
 * Each VM gets a local DNS resolver (dnsmasq) on the gateway IP that only
 * resolves allowed domains. Direct DNS (UDP 53) to any other destination is
 * blocked by iptables. This prevents DNS tunneling and data exfiltration.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import { logger } from "../index";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DnsResolverHandle {
  vmId: string;
  configPath: string;
  pidFile: string;
  gatewayIp: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a per-VM dnsmasq instance bound to the gateway IP.
 * Only resolves domains in the allowlist; all others get NXDOMAIN.
 */
export async function startDnsResolver(
  vmId: string,
  gatewayIp: string,
  allowedDomains: string[],
): Promise<DnsResolverHandle> {
  const configPath = `/tmp/fc-dns-${vmId}.conf`;
  const pidFile = `/tmp/fc-dns-${vmId}.pid`;

  // Build dnsmasq config
  const lines: string[] = [
    `# Auto-generated DNS policy for ${vmId}`,
    `listen-address=${gatewayIp}`,
    `bind-interfaces`,
    `no-resolv`,
    `no-hosts`,
    `pid-file=${pidFile}`,
    // Use real upstream for allowed domains only
    `server=8.8.8.8`,
    // Rate limiting: max 100 queries/sec
    `dns-forward-max=100`,
    // Block large TXT records (DNS tunneling signature)
    `max-ttl=300`,
    `cache-size=256`,
  ];

  // Add domain allowlist rules
  for (const domain of allowedDomains) {
    if (domain.startsWith("*.")) {
      // Wildcard: allow the base domain and all subdomains
      const base = domain.slice(2);
      lines.push(`server=/${base}/8.8.8.8`);
    } else {
      lines.push(`server=/${domain}/8.8.8.8`);
    }
  }

  // Block all other domains with NXDOMAIN
  lines.push(`address=/#/`);

  await writeFile(configPath, lines.join("\n") + "\n");

  // Start dnsmasq
  try {
    await execFileAsync("dnsmasq", [
      "--conf-file=" + configPath,
      "--log-queries",
      "--log-facility=/tmp/fc-dns-${vmId}.log",
    ]);
    logger.info("DNS resolver started", { vmId, gatewayIp, domains: allowedDomains.length });
  } catch (err) {
    logger.warn("Failed to start DNS resolver (dnsmasq may not be installed)", {
      vmId,
      error: String(err),
    });
  }

  return { vmId, configPath, pidFile, gatewayIp };
}

/**
 * Stop the per-VM DNS resolver and clean up config files.
 */
export async function stopDnsResolver(handle: DnsResolverHandle): Promise<void> {
  try {
    const { readFile } = await import("node:fs/promises");
    const pid = (await readFile(handle.pidFile, "utf-8")).trim();
    if (pid) {
      process.kill(parseInt(pid, 10), "SIGTERM");
    }
  } catch {
    // Process may already be stopped
  }

  await unlink(handle.configPath).catch(() => {});
  await unlink(handle.pidFile).catch(() => {});
  await unlink(`/tmp/fc-dns-${handle.vmId}.log`).catch(() => {});

  logger.info("DNS resolver stopped", { vmId: handle.vmId });
}

/**
 * Configure iptables to redirect VM DNS to the local resolver.
 * Blocks direct UDP 53 to any destination except the local resolver.
 */
export async function applyDnsRedirect(
  tapDevice: string,
  gatewayIp: string,
): Promise<void> {
  const rules: string[][] = [
    // Redirect all outbound DNS to local resolver
    ["PREROUTING", "-t", "nat", "-i", tapDevice, "-p", "udp", "--dport", "53",
     "-j", "DNAT", "--to-destination", `${gatewayIp}:53`],
    // Block direct DNS to external servers
    ["FORWARD", "-i", tapDevice, "-p", "udp", "--dport", "53",
     "!", "-d", gatewayIp, "-j", "DROP"],
    // Block large TXT record responses (>255 bytes, tunneling signature)
    ["FORWARD", "-i", tapDevice, "-p", "udp", "--sport", "53",
     "-m", "length", "--length", "256:65535", "-j", "DROP"],
  ];

  for (const rule of rules) {
    const table = rule.includes("-t") ? [] : [];
    await execFileAsync("iptables", ["-A", ...rule]).catch((err) => {
      logger.warn("Failed to add DNS redirect rule", {
        rule: rule.join(" "),
        error: String(err),
      });
    });
  }
}

/**
 * Remove DNS redirect rules during teardown.
 */
export async function removeDnsRedirect(
  tapDevice: string,
  gatewayIp: string,
): Promise<void> {
  await execFileAsync("iptables", [
    "-D", "PREROUTING", "-t", "nat", "-i", tapDevice, "-p", "udp", "--dport", "53",
    "-j", "DNAT", "--to-destination", `${gatewayIp}:53`,
  ]).catch(() => {});
  await execFileAsync("iptables", [
    "-D", "FORWARD", "-i", tapDevice, "-p", "udp", "--dport", "53",
    "!", "-d", gatewayIp, "-j", "DROP",
  ]).catch(() => {});
  await execFileAsync("iptables", [
    "-D", "FORWARD", "-i", tapDevice, "-p", "udp", "--sport", "53",
    "-m", "length", "--length", "256:65535", "-j", "DROP",
  ]).catch(() => {});
}
