import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createLLMClient } from "../lib/llm";
import {
  detectLanguageFromManifests,
  detectPackageManager,
} from "../lib/languageDetector";

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
      const fileData: Array<{
        filePath: string;
        sha: string;
        content: string;
        size: number;
      }> = JSON.parse(args.fileDataJson);

      const filePaths = fileData.map((f) => f.filePath);

      // Check for existing Dockerfile
      const dockerfilePatterns = [
        "Dockerfile",
        "dockerfile",
        "Dockerfile.dev",
        "docker/Dockerfile",
        ".devcontainer/Dockerfile",
      ];

      let foundDockerfile: { path: string; content: string } | null = null;

      for (const pattern of dockerfilePatterns) {
        const match = fileData.find(
          (f) =>
            f.filePath === pattern ||
            f.filePath.toLowerCase() === pattern.toLowerCase()
        );
        if (match) {
          foundDockerfile = { path: match.filePath, content: match.content };
          break;
        }
      }

      // Also check for docker-compose
      const dockerCompose = fileData.find(
        (f) =>
          f.filePath === "docker-compose.yml" ||
          f.filePath === "docker-compose.yaml" ||
          f.filePath === "compose.yml" ||
          f.filePath === "compose.yaml"
      );

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
        // Generate a Dockerfile via LLM
        const language = detectLanguageFromManifests(filePaths);
        const packageManager = detectPackageManager(filePaths);

        // Find manifest file content
        const manifestFiles = [
          "package.json",
          "requirements.txt",
          "Cargo.toml",
          "go.mod",
          "pom.xml",
          "pyproject.toml",
        ];
        let manifestContent = "";
        for (const mf of manifestFiles) {
          const found = fileData.find((f) => f.filePath === mf);
          if (found) {
            manifestContent = found.content.slice(0, 2000); // Truncate long manifests
            break;
          }
        }

        // Detect entry point
        const entryPoints = [
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
        const detectedEntryPoint =
          entryPoints.find((ep) => filePaths.includes(ep)) || "unknown";

        // Check for build script
        let hasBuildScript = false;
        const pkgJson = fileData.find((f) => f.filePath === "package.json");
        if (pkgJson) {
          try {
            const pkg = JSON.parse(pkgJson.content);
            hasBuildScript = !!pkg.scripts?.build;
          } catch {
            // ignore parse errors
          }
        }

        const systemPrompt = `Generate a production-quality Dockerfile for this project.

## Project Analysis
- Primary language: ${language || "unknown"}
- Package manager: ${packageManager || "unknown"}
- Package manifest: ${manifestContent || "not found"}
- Entry point: ${detectedEntryPoint}
- Has build step: ${hasBuildScript}

## Requirements
- Use official base images (node:20-slim, python:3.12-slim, golang:1.22, etc.)
- Multi-stage build if applicable (separate build and runtime stages)
- Install dependencies from lockfile (npm ci, pip install, etc.)
- Include the build/compile step
- Expose common ports if applicable
- Do NOT include test execution (tests are run separately)
- Pin base image versions (no :latest tags)

Output ONLY the Dockerfile content, no explanation.`;

        let dockerfileContent: string;

        try {
          const llm = createLLMClient(
            process.env.LLM_PROVIDER,
            process.env.LLM_MODEL,
            process.env.ANTHROPIC_API_KEY,
            process.env.OPENAI_API_KEY
          );

          dockerfileContent = await llm.chat([
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: "Generate the Dockerfile for this project.",
            },
          ]);

          // Strip markdown code fences if present
          dockerfileContent = dockerfileContent
            .replace(/^```dockerfile\n?/i, "")
            .replace(/^```docker\n?/i, "")
            .replace(/^```\n?/, "")
            .replace(/\n?```$/, "")
            .trim();
        } catch (llmError) {
          // Fallback: generate a basic Dockerfile based on language
          dockerfileContent = generateFallbackDockerfile(
            language || "unknown",
            packageManager
          );
        }

        await ctx.runMutation(internal.repoConnections.updateDockerfile, {
          repoConnectionId: args.repoConnectionId,
          dockerfilePath: undefined,
          dockerfileContent,
          dockerfileSource: "generated",
        });
      }

      // Chain to parse pipeline
      await ctx.runMutation(internal.repoConnections.updateStatus, {
        repoConnectionId: args.repoConnectionId,
        status: "parsing",
      });

      await ctx.scheduler.runAfter(0, internal.pipelines.parseRepo.parseRepo, {
        repoConnectionId: args.repoConnectionId,
        bountyId: args.bountyId,
        fileDataJson: args.fileDataJson,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during Dockerfile check";
      console.error(`ensureDockerfile failed: ${errorMessage}`);

      // Don't fail the whole pipeline for Dockerfile issues — proceed to parse
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
