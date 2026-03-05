import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createLLMClient } from "../lib/llm";
import {
  detectLanguageFromManifests,
  detectPackageManager,
} from "../lib/languageDetector";

type RepoFileData = {
  filePath: string;
  sha: string;
  content: string;
  size: number;
};

const DOCKERFILE_PATTERNS = [
  "Dockerfile",
  "dockerfile",
  "Dockerfile.dev",
  "docker/Dockerfile",
  ".devcontainer/Dockerfile",
];

const MANIFEST_FILES = [
  "package.json",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "pyproject.toml",
];

const ENTRY_POINTS = [
  "src/index.ts",
  "src/main.ts",
  "index.ts",
  "main.ts",
  "src/index.js",
  "index.js",
  "main.py",
  "app.py",
  "main.go",
  "cmd/main.go",
  "src/main.rs",
];

type EnsureDockerfileContext = {
  runMutation: (mutation: unknown, args: Record<string, unknown>) => Promise<unknown>;
  scheduler: {
    runAfter: (delayMs: number, action: unknown, args: Record<string, unknown>) => Promise<unknown>;
  };
};

function parseFileData(fileDataJson: string): RepoFileData[] {
  return JSON.parse(fileDataJson) as RepoFileData[];
}

function findExistingDockerfile(fileData: RepoFileData[]): { path: string; content: string } | null {
  for (const pattern of DOCKERFILE_PATTERNS) {
    const match = fileData.find(
      (file) =>
        file.filePath === pattern ||
        file.filePath.toLowerCase() === pattern.toLowerCase(),
    );
    if (match) {
      return { path: match.filePath, content: match.content };
    }
  }
  return null;
}

function extractManifestContent(fileData: RepoFileData[]): string {
  for (const manifestFile of MANIFEST_FILES) {
    const found = fileData.find((file) => file.filePath === manifestFile);
    if (found) {
      return found.content.slice(0, 2000);
    }
  }
  return "";
}

function detectEntryPoint(filePaths: string[]): string {
  return ENTRY_POINTS.find((entryPoint) => filePaths.includes(entryPoint)) ?? "unknown";
}

function detectBuildScript(fileData: RepoFileData[]): boolean {
  const packageJson = fileData.find((file) => file.filePath === "package.json");
  if (!packageJson) return false;
  try {
    const parsed = JSON.parse(packageJson.content) as { scripts?: { build?: unknown } };
    return Boolean(parsed.scripts?.build);
  } catch {
    return false;
  }
}

function sanitizeDockerfileOutput(content: string): string {
  return content
    .replace(/^```dockerfile\n?/i, "")
    .replace(/^```docker\n?/i, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
}

function buildDockerfileSystemPrompt(params: {
  language: string | null;
  packageManager: string | null;
  manifestContent: string;
  detectedEntryPoint: string;
  hasBuildScript: boolean;
}): string {
  return `Generate a production-quality Dockerfile for this project.

## Project Analysis
- Primary language: ${params.language || "unknown"}
- Package manager: ${params.packageManager || "unknown"}
- Package manifest: ${params.manifestContent || "not found"}
- Entry point: ${params.detectedEntryPoint}
- Has build step: ${params.hasBuildScript}

## Requirements
- Use official base images (node:20-slim, python:3.12-slim, golang:1.22, etc.)
- Multi-stage build if applicable (separate build and runtime stages)
- Install dependencies from lockfile (npm ci, pip install, etc.)
- Include the build/compile step
- Expose common ports if applicable
- Do NOT include test execution (tests are run separately)
- Pin base image versions (no :latest tags)

Output ONLY the Dockerfile content, no explanation.`;
}

async function generateDockerfileContent(
  fileData: RepoFileData[],
  filePaths: string[],
): Promise<string> {
  const language = detectLanguageFromManifests(filePaths);
  const packageManager = detectPackageManager(filePaths);
  const systemPrompt = buildDockerfileSystemPrompt({
    language,
    packageManager,
    manifestContent: extractManifestContent(fileData),
    detectedEntryPoint: detectEntryPoint(filePaths),
    hasBuildScript: detectBuildScript(fileData),
  });

  try {
    const llm = createLLMClient(
      process.env.LLM_PROVIDER,
      process.env.LLM_MODEL,
      process.env.ANTHROPIC_API_KEY,
      process.env.OPENAI_API_KEY,
    );
    const generated = await llm.chat([
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: "Generate the Dockerfile for this project.",
      },
    ]);
    return sanitizeDockerfileOutput(generated);
  } catch (error_) {
    console.warn(
      `ensureDockerfile LLM generation failed, using fallback: ${
        error_ instanceof Error ? error_.message : String(error_)
      }`,
    );
    return generateFallbackDockerfile(language || "unknown", packageManager);
  }
}

async function continueToParseStage(
  ctx: EnsureDockerfileContext,
  args: { repoConnectionId: string; bountyId: string; fileDataJson: string },
): Promise<void> {
  await ctx.runMutation(internal.repoConnections.updateStatus, {
    repoConnectionId: args.repoConnectionId,
    status: "parsing",
  });
  await ctx.scheduler.runAfter(0, internal.pipelines.parseRepo.parseRepo, {
    repoConnectionId: args.repoConnectionId,
    bountyId: args.bountyId,
    fileDataJson: args.fileDataJson,
  });
}

/**
 * Ensure a Dockerfile exists for the repository.
 * If one is found, validate it. If not, generate one via LLM.
 *
 * Pipeline chain: fetchRepo → ensureDockerfile → parseRepo → indexRepo
 */
export const ensureDockerfile = internalAction({
  args: {
    repoConnectionId: v.id("repoConnections"),
    bountyId: v.id("bounties"),
    fileDataJson: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      const fileData = parseFileData(args.fileDataJson);

      const filePaths = fileData.map((f) => f.filePath);

      // Check for existing Dockerfile
      const foundDockerfile = findExistingDockerfile(fileData);

      if (foundDockerfile) {
        // Validate the Dockerfile has at least a FROM instruction
        const hasFrom = /^\s*FROM\s+/m.test(foundDockerfile.content);
        if (!hasFrom) {
          console.warn(
            `Dockerfile at ${foundDockerfile.path} has no FROM instruction`
          );
        }

        await ctx.runMutation(internal.repoConnections.updateDockerfile, {
          repoConnectionId: args.repoConnectionId,
          dockerfilePath: foundDockerfile.path,
          dockerfileContent: foundDockerfile.content,
          dockerfileSource: "repo",
        });
      } else {
        const dockerfileContent = await generateDockerfileContent(fileData, filePaths);
        await ctx.runMutation(internal.repoConnections.updateDockerfile, {
          repoConnectionId: args.repoConnectionId,
          dockerfilePath: undefined,
          dockerfileContent,
          dockerfileSource: "generated",
        });
      }

      await continueToParseStage(ctx, {
        repoConnectionId: args.repoConnectionId,
        bountyId: args.bountyId,
        fileDataJson: args.fileDataJson,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error during Dockerfile check";
      console.error(`ensureDockerfile failed: ${errorMessage}`);

      // Don't fail the whole pipeline for Dockerfile issues — proceed to parse
      await continueToParseStage(ctx, {
        repoConnectionId: args.repoConnectionId,
        bountyId: args.bountyId,
        fileDataJson: args.fileDataJson,
      });
    }
  },
});

function generateFallbackDockerfile(
  language: string,
  packageManager: string | null
): string {
  switch (language) {
    case "typescript":
    case "javascript":
      return `FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build || true

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app .
EXPOSE 3000
CMD ["node", "dist/index.js"]`;

    case "python":
      return `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["python", "main.py"]`;

    case "go":
      return `FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /app/main ./...

FROM alpine:3.19
WORKDIR /app
COPY --from=builder /app/main .
EXPOSE 8080
CMD ["./main"]`;

    case "rust":
      return `FROM rust:1.77-slim AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=builder /app/target/release/* .
EXPOSE 8080
CMD ["./app"]`;

    case "java":
      return `FROM maven:3.9-eclipse-temurin-21 AS builder
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:resolve
COPY src ./src
RUN mvn package -DskipTests

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=builder /app/target/*.jar app.jar
EXPOSE 8080
CMD ["java", "-jar", "app.jar"]`;

    default:
      return `FROM ubuntu:22.04
WORKDIR /app
COPY . .
CMD ["bash"]`;
  }
}
