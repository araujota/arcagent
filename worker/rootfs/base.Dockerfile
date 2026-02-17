# ---------------------------------------------------------------------------
# Base rootfs image for Firecracker microVMs
#
# Minimal Alpine Linux with essential tools for cloning repositories and
# running CI gates.  Language-specific images extend this base.
#
# Build:
#   docker build -t arcagent-rootfs-base -f rootfs/base.Dockerfile rootfs/
#
# Export as ext4:
#   docker run --rm arcagent-rootfs-base tar -C / -cf - . | \
#     dd of=base.ext4 bs=1M count=512
#   mkfs.ext4 -F base.ext4
# ---------------------------------------------------------------------------

FROM alpine:3.19 AS base

# Install core packages
RUN apk add --no-cache \
    bash \
    ca-certificates \
    curl \
    git \
    openssh-client \
    openssh-server \
    jq \
    wget \
    tar \
    gzip \
    xz \
    sudo \
    shadow \
    ripgrep \
    && rm -rf /var/cache/apk/*

# Configure SSH server for host-to-guest communication
RUN ssh-keygen -A \
    && mkdir -p /root/.ssh \
    && chmod 700 /root/.ssh \
    && echo "PermitRootLogin yes" >> /etc/ssh/sshd_config \
    && echo "PasswordAuthentication no" >> /etc/ssh/sshd_config \
    && echo "PubkeyAuthentication yes" >> /etc/ssh/sshd_config \
    && echo "UseDNS no" >> /etc/ssh/sshd_config \
    && echo "MaxSessions 10" >> /etc/ssh/sshd_config

# Create workspace directory and agent user (uid 1000)
RUN mkdir -p /workspace && chmod 777 /workspace
RUN adduser -D -u 1000 -h /home/agent -s /bin/bash agent \
    && echo "agent ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Install vsock-agent binary for host ↔ guest communication
COPY vsock-agent /usr/local/bin/vsock-agent
RUN chmod 755 /usr/local/bin/vsock-agent

# Configure networking
RUN echo "nameserver 8.8.8.8" > /etc/resolv.conf \
    && echo "nameserver 8.8.4.4" >> /etc/resolv.conf

# Startup script: launch SSH and keep the VM alive
COPY <<'EOF' /init.sh
#!/bin/bash
set -e

# Start SSH daemon
/usr/sbin/sshd -D &

# Copy authorized keys if provided via kernel command line
if [ -f /root/.ssh/authorized_keys ]; then
    chmod 600 /root/.ssh/authorized_keys
fi

# Start vsock agent for host ↔ guest communication
/usr/local/bin/vsock-agent &

# Keep the init process alive
exec sleep infinity
EOF

RUN chmod +x /init.sh

# Set resource limits for sandboxing
RUN echo "* soft nofile 65536" >> /etc/security/limits.conf \
    && echo "* hard nofile 65536" >> /etc/security/limits.conf \
    && echo "* soft nproc 4096" >> /etc/security/limits.conf \
    && echo "* hard nproc 4096" >> /etc/security/limits.conf

ENTRYPOINT ["/init.sh"]
