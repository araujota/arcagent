import fs from "node:fs";
import path from "node:path";

const CWD = process.cwd().replace(/\\/g, "/");

const services = [
  {
    name: "webui",
    lcovPath: "coverage/webui/lcov.info",
    minTotalLines: 80,
    criticalFiles: [
      { file: "src/components/bounties/bounty-card.tsx", minLines: 90 },
      { file: "src/components/landing/live-activity-feed.tsx", minLines: 90 },
      { file: "src/components/landing/waitlist-form.tsx", minLines: 90 },
    ],
  },
  {
    name: "convex",
    lcovPath: "coverage/convex/lcov.info",
    minTotalLines: 80,
    criticalFiles: [
      { file: "convex/agentStats.ts", minLines: 80 },
      { file: "convex/testBounties.ts", minLines: 90 },
      { file: "convex/lib/gherkinValidator.ts", minLines: 95 },
      { file: "convex/pipelines/dispatchVerification.ts", minLines: 80 },
    ],
  },
  {
    name: "worker",
    lcovPath: "worker/coverage/lcov.info",
    minTotalLines: 80,
    criticalFiles: [
      { file: "src/api/auth.ts", minLines: 90 },
      { file: "src/lib/resultParser.ts", minLines: 95 },
      { file: "src/workspace/recovery.ts", minLines: 90 },
      { file: "src/lib/feedbackFormatter.ts", minLines: 90 },
    ],
  },
  {
    name: "mcp",
    lcovPath: "mcp-server/coverage/lcov.info",
    minTotalLines: 80,
    criticalFiles: [
      { file: "src/auth/apiKeyAuth.ts", minLines: 90 },
      { file: "src/worker/client.ts", minLines: 90 },
      { file: "src/tools/claimBounty.ts", minLines: 90 },
      { file: "src/tools/getBountyDetails.ts", minLines: 90 },
    ],
  },
];

function normalizePath(input) {
  const normalized = input.replace(/\\/g, "/");
  if (normalized.startsWith(`${CWD}/`)) {
    return normalized.slice(CWD.length + 1);
  }
  return normalized;
}

function parseLcov(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing LCOV file: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  let currentFile = null;
  let current = null;
  const perFile = new Map();
  let totalHit = 0;
  let totalFound = 0;

  const flushCurrent = () => {
    if (!currentFile || !current) {
      return;
    }
    const normalized = normalizePath(currentFile);
    perFile.set(normalized, {
      hit: current.hit,
      found: current.found,
      pct: current.found > 0 ? (current.hit / current.found) * 100 : 100,
    });
    totalHit += current.hit;
    totalFound += current.found;
  };

  for (const line of lines) {
    if (line.startsWith("SF:")) {
      flushCurrent();
      currentFile = line.slice(3).trim();
      current = { hit: 0, found: 0 };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("LH:")) {
      current.hit = Number(line.slice(3).trim()) || 0;
      continue;
    }

    if (line.startsWith("LF:")) {
      current.found = Number(line.slice(3).trim()) || 0;
    }
  }

  flushCurrent();

  return {
    perFile,
    totalHit,
    totalFound,
    totalPct: totalFound > 0 ? (totalHit / totalFound) * 100 : 100,
  };
}

function formatPct(value) {
  return `${value.toFixed(2)}%`;
}

function main() {
  const failures = [];

  for (const service of services) {
    const resolved = path.resolve(CWD, service.lcovPath);
    const report = parseLcov(resolved);
    const totalLine = `[${service.name}] total lines ${formatPct(report.totalPct)} (${report.totalHit}/${report.totalFound})`;
    console.log(totalLine);

    if (report.totalPct < service.minTotalLines) {
      failures.push(
        `[${service.name}] total lines ${formatPct(report.totalPct)} is below ${service.minTotalLines}%`,
      );
    }

    for (const check of service.criticalFiles) {
      const fileStats = report.perFile.get(check.file);
      if (!fileStats) {
        failures.push(`[${service.name}] missing critical file in coverage report: ${check.file}`);
        continue;
      }

      const detail = `  - ${check.file}: ${formatPct(fileStats.pct)} (${fileStats.hit}/${fileStats.found})`;
      console.log(detail);
      if (fileStats.pct < check.minLines) {
        failures.push(
          `[${service.name}] critical file ${check.file} is ${formatPct(fileStats.pct)} (< ${check.minLines}%)`,
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error("\nCoverage threshold failures:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("\nCore coverage thresholds satisfied.");
}

main();
