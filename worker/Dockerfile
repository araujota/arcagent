# Stage 1: Build TypeScript
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: Download Firecracker binaries
FROM debian:bookworm-slim AS firecracker
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
ARG FIRECRACKER_VERSION=1.7.0
RUN ARCH=$(uname -m) && \
    curl -fSL "https://github.com/firecracker-microvm/firecracker/releases/download/v${FIRECRACKER_VERSION}/firecracker-v${FIRECRACKER_VERSION}-${ARCH}.tgz" \
      -o /tmp/firecracker.tgz && \
    tar -xzf /tmp/firecracker.tgz -C /tmp && \
    mv /tmp/release-v${FIRECRACKER_VERSION}-${ARCH}/firecracker-v${FIRECRACKER_VERSION}-${ARCH} /usr/local/bin/firecracker && \
    mv /tmp/release-v${FIRECRACKER_VERSION}-${ARCH}/jailer-v${FIRECRACKER_VERSION}-${ARCH} /usr/local/bin/jailer && \
    chmod +x /usr/local/bin/firecracker /usr/local/bin/jailer && \
    rm -rf /tmp/firecracker.tgz /tmp/release-*

# Stage 3: Production runner
FROM node:20-slim AS runner
WORKDIR /app

# System dependencies for Firecracker jailer and networking
RUN apt-get update && apt-get install -y --no-install-recommends \
    iproute2 \
    iptables \
    cryptsetup-bin \
    dmsetup \
    kmod \
    procps \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Ensure process-backend commands can always drop to a non-root execution user.
RUN if ! id -u agent >/dev/null 2>&1; then \
      useradd --create-home --shell /bin/bash -U agent; \
    fi && \
    install -d -m 0755 -o agent -g agent /workspace

# Copy Firecracker binaries
COPY --from=firecracker /usr/local/bin/firecracker /usr/local/bin/firecracker
COPY --from=firecracker /usr/local/bin/jailer /usr/local/bin/jailer

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

ENV NODE_ENV=production

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

CMD ["node", "dist/index.js"]
