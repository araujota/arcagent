# ---------------------------------------------------------------------------
# Node.js 20 rootfs image for Firecracker microVMs
#
# Extends the base Alpine image with Node.js 20 LTS, common CI tools,
# and security scanners required by the verification pipeline.
#
# Build:
#   docker build -t arcagent-rootfs-node -f rootfs/node.Dockerfile rootfs/
#
# Export as ext4:
#   container_id=$(docker create arcagent-rootfs-node)
#   docker export $container_id | dd of=node-20.ext4 bs=1M
#   docker rm $container_id
#   resize2fs node-20.ext4 1G
# ---------------------------------------------------------------------------

FROM arcagent-rootfs-base AS node-rootfs

# ---------------------------------------------------------------------------
# Node.js 20 LTS
# ---------------------------------------------------------------------------
RUN apk add --no-cache \
    nodejs-current~=20 \
    npm \
    && npm install -g \
      yarn@1 \
      pnpm@9 \
    && npm cache clean --force

# Verify Node.js installation
RUN node --version && npm --version && yarn --version && pnpm --version

# ---------------------------------------------------------------------------
# TypeScript tooling
# ---------------------------------------------------------------------------
RUN npm install -g \
    typescript@5 \
    tsx \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Linting & formatting
# ---------------------------------------------------------------------------
RUN npm install -g \
    eslint@9 \
    prettier@3 \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Security scanners
# ---------------------------------------------------------------------------

# Trivy vulnerability scanner
RUN curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin

# Semgrep SAST
RUN apk add --no-cache python3 py3-pip \
    && pip3 install --break-system-packages semgrep \
    && rm -rf /root/.cache/pip

# ---------------------------------------------------------------------------
# SonarQube scanner CLI
# ---------------------------------------------------------------------------
ENV SONAR_SCANNER_VERSION=5.0.1.3006
RUN curl -sL "https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-${SONAR_SCANNER_VERSION}-linux.zip" -o /tmp/sonar-scanner.zip \
    && unzip -q /tmp/sonar-scanner.zip -d /opt \
    && ln -s "/opt/sonar-scanner-${SONAR_SCANNER_VERSION}-linux/bin/sonar-scanner" /usr/local/bin/sonar-scanner \
    && rm /tmp/sonar-scanner.zip

# ---------------------------------------------------------------------------
# Test runners (installed globally as fallbacks; projects bring their own)
# ---------------------------------------------------------------------------
RUN npm install -g \
    jest@29 \
    vitest@2 \
    mocha@10 \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
RUN rm -rf /tmp/* /var/cache/apk/* /root/.npm

# Workspace
WORKDIR /workspace

ENTRYPOINT ["/init.sh"]
