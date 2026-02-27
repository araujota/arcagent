# Worker Deployment Guide

This guide covers deploying the ArcAgent verification worker — from local development through production on AWS.

## Architecture Overview

```
┌──────────────────┐         ┌──────────────────────────────────────┐
│   Convex Backend  │  POST   │          Worker (port 3001)          │
│                   │────────▶│  Express + BullMQ + Redis            │
│  - Submits jobs   │         │                                      │
│  - Receives       │◀────────│  8-gate verification pipeline:       │
│    results        │  POST   │  build → lint → typecheck → security │
│                   │         │  → memory → snyk → sonarqube → test  │
└──────────────────┘         │                                      │
                              │  ┌──────────────────────────────┐    │
                              │  │  Firecracker microVMs        │    │
                              │  │  - Isolated per job          │    │
                              │  │  - Language-specific rootfs   │    │
                              │  │  - vsock communication       │    │
                              │  │  - Egress filtering          │    │
                              │  └──────────────────────────────┘    │
                              └──────────────────────────────────────┘
```

**Key points:**
- The worker is independently deployed — it runs on your own infrastructure, not alongside Convex
- Requires **Linux with KVM support** (bare-metal EC2 for production)
- Requires **Redis** for the BullMQ job queue
- Firecracker microVMs provide per-job isolation with language-specific rootfs images
- Communication between Convex and the worker is authenticated via `WORKER_SHARED_SECRET` (constant-time comparison)

## Local Development (Docker Compose)

The project includes a `docker-compose.yml` at the repo root with all services.

### Worker stack only

```bash
docker compose up redis worker
```

This starts Redis (port 6379) and the worker (port 3001). The worker container automatically connects to Redis via the internal `arcagent` network.

### Full stack

```bash
docker compose up
```

Starts all services: `redis`, `web` (Next.js on port 3000), `worker` (port 3001), and `mcp-server` (HTTP transport on port 3002).

### With SonarQube (optional gate)

```bash
docker compose --profile sonarqube up
```

This adds `sonarqube` (port 9000) and its `sonarqube-db` (Postgres) service in the same compose environment as worker+redis. SonarQube is an optional verification gate — it only runs if enabled per-bounty by the creator.

### Environment variables

Create a `.env` file at the repo root (loaded by all services via `env_file`). Reference `worker/.env.example` for the full list. The critical variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `CONVEX_URL` | Yes | Convex deployment URL (e.g. `https://your-app.convex.cloud`) |
| `CONVEX_HTTP_ACTIONS_URL` | Recommended | Convex HTTP actions URL (e.g. `https://your-app.convex.site`) |
| `WORKER_SHARED_SECRET` | Yes | Must match the value set in Convex env |
| `REDIS_URL` | No | Overridden to `redis://redis:6379` by Docker Compose |
| `PORT` | No | Default: `3001` |
| `WORKSPACE_ISOLATION_MODE` | No | `shared_worker` (default) |

### Firecracker in Docker

The Docker Compose config mounts `/dev/kvm` and `/dev/net/tun` from the host and adds the required capabilities (`SYS_ADMIN`, `NET_ADMIN`, `NET_RAW`, `MKNOD`). **Your host must be Linux with KVM support** — Firecracker cannot run inside Docker on macOS or Windows.

For local development without Firecracker (e.g. on macOS), you can run the worker directly:

```bash
cd worker && npm run dev
```

This starts the Express server with BullMQ but VM operations will fail unless KVM is available.

### Pulling worker envs from Vercel before local deploy

From repo root:

```bash
npm run env:sync:worker
```

This generates `worker/.env.generated` (gitignored, mode `0600`) and overlays it on top of `worker/.env` in both root and worker `docker compose` configurations.

## Production Deployment to AWS (Terraform)

The `infra/aws/` directory contains complete Terraform configuration for deploying worker instances on bare-metal EC2.

### Prerequisites

- AWS CLI configured with appropriate credentials
- Terraform >= 1.5
- An EC2 key pair created in your target region
- Your Convex deployment URL and shared secret

### Infrastructure overview

Terraform provisions:
- **VPC** (`10.1.0.0/16`) with public subnets — uses `10.1.x.x` to avoid collision with Firecracker's internal `10.0.0.0/24` TAP subnet
- **Bare-metal EC2 instances** (`c6i.metal` by default) with KVM support
- **Elastic IPs** for stable worker addressing
- **Security group** — port 3001 open for Convex/MCP inbound, SSH restricted to specified CIDRs
- **IAM role** with CloudWatch Logs, SSM, and ECR read access

### Step-by-step deployment

#### 1. Configure Terraform variables

```bash
cd infra/aws
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` with your values:

```hcl
aws_region   = "us-east-1"
environment  = "production"

# Must be .metal for KVM/Firecracker support
instance_type = "c6i.metal"
worker_count  = 1
ssh_key_name  = "your-key-pair-name"

# Restrict SSH to your IP
ssh_allowed_cidrs = ["YOUR_IP/32"]

# Must match the WORKER_SHARED_SECRET set in Convex env
worker_shared_secret = "your-worker-shared-secret"
convex_url           = "https://your-app.convex.cloud"
convex_http_actions_url = "https://your-app.convex.site"
```

See [Terraform Variable Reference](#terraform-variable-reference) for all options.

> **Never commit `terraform.tfvars`** — it contains secrets.

#### 2. Deploy infrastructure

```bash
cd infra/aws
terraform init
terraform plan    # Review changes
terraform apply   # Confirm and deploy
```

Note the outputs:

```
worker_host_urls  = ["http://<eip>:3001"]
ssh_command       = "ssh -i <key.pem> ubuntu@<eip>"
```

#### 3. Copy provisioning scripts to the host

The `setup-host.sh` script runs as user-data on first boot but needs the helper scripts:

```bash
scp -i <key.pem> infra/aws/scripts/* ubuntu@<eip>:/opt/arcagent/scripts/
```

If the scripts weren't present during first boot, re-run setup:

```bash
ssh -i <key.pem> ubuntu@<eip> 'sudo bash /var/lib/cloud/instance/user-data.txt'
```

#### 4. Build and deploy the worker code

On your build machine:

```bash
cd worker
npm ci
npm run build
tar czf worker-build.tar.gz dist/ package.json package-lock.json
```

Copy to the host and deploy:

```bash
scp -i <key.pem> worker-build.tar.gz ubuntu@<eip>:/tmp/
ssh -i <key.pem> ubuntu@<eip> 'sudo bash /opt/arcagent/deploy.sh /tmp/worker-build.tar.gz'
```

The `deploy.sh` script (created by `setup-worker.sh`) stops the service, extracts the archive, runs `npm ci --production`, and restarts the service.

#### 5. Set WORKER_API_URL in Convex

```bash
npx convex env set WORKER_API_URL "http://<eip>:3001"
```

Ensure `WORKER_SHARED_SECRET` is also set in Convex to the same value as in `terraform.tfvars`.

#### 6. Verify

```bash
curl http://<eip>:3001/api/health
# Expected: {"status":"ok","timestamp":"..."}
```

## Scaling

### Horizontal scaling (more instances)

Increase `worker_count` in `terraform.tfvars`:

```hcl
worker_count = 3
```

Run `terraform apply`. Each instance gets its own EIP. BullMQ distributes jobs across all workers connected to the same Redis instance.

> **Note:** The default setup uses a local Redis per host. For multi-host horizontal scaling, you need a shared Redis instance (e.g. Amazon ElastiCache). Update `REDIS_URL` in `/opt/arcagent/worker.env` on each host to point to the shared Redis.

### Vertical scaling (more throughput per instance)

Adjust these variables in `terraform.tfvars`:

| Variable | Default | Description |
|----------|---------|-------------|
| `worker_concurrency` | `2` | Parallel BullMQ verification jobs per instance |
| `max_dev_vms` | `10` | Maximum concurrent development VMs |
| `warm_pool_size` | `2` | Pre-warmed VMs per language (faster job start) |
| `max_warm_vms` | `4` | Maximum total warm VMs across all languages |

The BullMQ worker also enforces a rate limit of **10 jobs per minute** per instance (configurable in `worker/src/queue/jobQueue.ts`).

### VM resource allocation per language

Each language has a fixed resource profile defined in `worker/src/vm/vmConfig.ts`:

| Language | vCPUs | RAM (MiB) | Gate Timeout | Rootfs Image |
|----------|-------|-----------|-------------|--------------|
| TypeScript | 2 | 1024 | 2 min | `node-20.ext4` |
| JavaScript | 2 | 1024 | 2 min | `node-20.ext4` |
| Python | 2 | 1024 | 2 min | `python-312.ext4` |
| Go | 2 | 1024 | 2 min | `go-122.ext4` |
| Ruby | 2 | 1024 | 2 min | `ruby-33.ext4` |
| PHP | 2 | 1024 | 2 min | `php-84.ext4` |
| C | 2 | 1024 | 3 min | `cpp-gcc14.ext4` |
| Rust | 4 | 2048 | 5 min | `rust-stable.ext4` |
| Java | 4 | 2048 | 3 min | `java-21.ext4` |
| C++ | 4 | 2048 | 5 min | `cpp-gcc14.ext4` |
| C# | 4 | 2048 | 3 min | `dotnet-9.ext4` |
| Swift | 4 | 2048 | 3 min | `swift-6.ext4` |
| Kotlin | 4 | 2048 | 3 min | `kotlin-jvm21.ext4` |

A `c6i.metal` instance has 128 vCPUs and 256 GiB RAM — plan your `worker_concurrency` and `max_dev_vms` accordingly.

## Updating / Redeploying

### Option A: Build locally, deploy via scp

```bash
# On your build machine
cd worker
npm run build
tar czf worker-build.tar.gz dist/ package.json package-lock.json

# Deploy to host
scp -i <key.pem> worker-build.tar.gz ubuntu@<eip>:/tmp/
ssh -i <key.pem> ubuntu@<eip> 'sudo bash /opt/arcagent/deploy.sh /tmp/worker-build.tar.gz'
```

`deploy.sh` handles: stop service → extract archive → `npm ci --production` → start service.

### Option B: Rebuild Docker image

```bash
cd worker
docker build -t arcagent-worker:latest .
# Push to your registry and redeploy the container
```

### Zero-downtime updates (multi-instance)

With multiple worker instances, update one at a time. BullMQ will route jobs to the remaining healthy workers while one is restarting.

## Monitoring & Troubleshooting

### Logs

```bash
# Follow live logs
journalctl -u arcagent-worker -f

# Last 100 lines
journalctl -u arcagent-worker -n 100 --no-pager

# Setup log (user-data / first boot)
cat /var/log/arcagent-setup.log
```

### Health check

```bash
curl http://<eip>:3001/api/health
# {"status":"ok","timestamp":"2026-02-20T12:00:00.000Z"}
```

The Dockerfile defines a healthcheck that hits `http://localhost:3001/health` every 30s. Note: the actual Express endpoint is `/api/health` — if you see the container marked unhealthy, update the Dockerfile `HEALTHCHECK` path to `/api/health`.

### Service management

```bash
sudo systemctl status arcagent-worker
sudo systemctl restart arcagent-worker
sudo systemctl stop arcagent-worker
```

### Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `KVM not available` or `/dev/kvm: No such file` | Instance is not `.metal` or KVM module not loaded | Use a `.metal` instance type. Verify with `ls -la /dev/kvm` |
| `Redis connection refused` | Redis not running | `sudo systemctl start redis-server` and verify with `redis-cli ping` |
| `Rootfs image not found` | `build-rootfs.sh` hasn't run | `sudo bash /opt/arcagent/scripts/build-rootfs.sh` |
| `Firecracker binary not found` | `install-firecracker.sh` hasn't run | `sudo bash /opt/arcagent/scripts/install-firecracker.sh 1.7.0` |
| `WORKER_HOST_URL` is `localhost` | EIP not yet attached during first boot | Restart the service: `sudo systemctl restart arcagent-worker` (the `detect-host-url.sh` ExecStartPre re-detects the public IP) |
| `401 Unauthorized` from Convex | `WORKER_SHARED_SECRET` mismatch | Ensure the secret in `/opt/arcagent/worker.env` matches the Convex env var |
| Worker starts but jobs fail | VM networking issues | Verify IP forwarding: `sysctl net.ipv4.ip_forward` (should be `1`). Check NAT rules: `iptables -t nat -L POSTROUTING` |

## Security Considerations

### Authentication

- **`WORKER_SHARED_SECRET`** authenticates all Convex-to-worker and worker-to-Convex communication. It must match on both sides. Comparison uses constant-time equality (SECURITY H3).
- The health endpoint (`GET /api/health`) is intentionally unauthenticated. All other `/api/*` routes require the shared secret in the `Authorization` header.

### Instance hardening

- **IMDSv2 enforced** — `http_tokens = "required"` in the EC2 metadata options prevents SSRF-based credential theft via IMDSv1.
- **Encrypted EBS** — root volumes use `encrypted = true`.
- **SSH restricted** — only allowed from CIDRs specified in `ssh_allowed_cidrs`. Leave empty to disable SSH entirely (use SSM Session Manager instead).

### Egress filtering

When `harden_egress = true` (default), the worker configures:
- **Squid proxy** with SSL bumping for HTTPS inspection
- **Per-language domain allowlists** — each VM can only reach its language's package registry (e.g. `registry.npmjs.org` for Node.js, `crates.io` for Rust) plus GitHub
- **Rate limiting** on TAP devices via `tc qdisc` (10 Mbit/s per VM)

### Why root?

The worker systemd service runs as `root` because it needs to:
- Create TAP network devices for VM networking
- Manage iptables rules for NAT and egress filtering
- Run the Firecracker `jailer` (which needs `cap_sys_admin`, `cap_net_admin`)
- Set up dm-crypt for encrypted overlay filesystems

Code inside VMs runs as an unprivileged `agent` user (uid 1001). The Firecracker microVM boundary provides the isolation.

## Environment Variable Reference

### Worker environment (`worker/.env.example`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CONVEX_URL` | Yes | — | Convex deployment URL |
| `CONVEX_HTTP_ACTIONS_URL` | No | derived from `CONVEX_URL` | Convex HTTP actions URL for `/api/*` callbacks |
| `WORKER_SHARED_SECRET` | Yes | — | Shared secret (must match Convex env) |
| `REDIS_URL` | Yes | `redis://localhost:6379` | Redis connection URL |
| `PORT` | No | `3001` | Server port |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `WORKER_HOST_URL` | No | Auto-detected | Public URL of this worker instance |
| `FIRECRACKER_BIN` | No | `/usr/local/bin/firecracker` | Path to Firecracker binary |
| `JAILER_BIN` | No | `/usr/local/bin/jailer` | Path to jailer binary |
| `FC_KERNEL_IMAGE` | No | `/var/lib/firecracker/vmlinux` | Path to kernel image |
| `FC_ROOTFS_DIR` | No | `/var/lib/firecracker/rootfs` | Path to rootfs images directory |
| `FC_USE_VSOCK` | No | `true` | Use vsock for host-guest communication |
| `FC_HARDEN_EGRESS` | No | `true` (production) | Enable egress filtering |
| `FC_SSH_KEY_PATH` | No | `/root/.ssh/id_ed25519` | SSH key for SSH fallback |
| `FC_GUEST_SSH_PORT` | No | `22` | SSH port on guest VM |
| `MAX_DEV_VMS` | No | `10` | Maximum concurrent dev VMs |
| `WORKSPACE_IDLE_TIMEOUT_MS` | No | `1800000` | Idle workspace timeout (30 min) |
| `SONARQUBE_URL` | No | — | SonarQube server URL (enables gate) |
| `SONARQUBE_TOKEN` | No | — | SonarQube auth token |
| `SNYK_TOKEN` | No | — | Snyk CLI token (SaaS-backed gate) |
| `GITHUB_API_TOKEN` | No | — | Primary GitHub token for repo access and language detection |
| `GITHUB_TOKEN` | Deprecated fallback | — | Backward-compatible fallback token. Prefer `GITHUB_API_TOKEN` |

### Terraform variables (`infra/aws/terraform.tfvars.example`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `aws_region` | No | `us-east-1` | AWS region |
| `environment` | No | `production` | Environment name |
| `instance_type` | No | `c6i.metal` | EC2 instance type (must be `.metal`) |
| `worker_count` | No | `1` | Number of worker instances |
| `ssh_key_name` | Yes | — | EC2 key pair name |
| `ssh_allowed_cidrs` | No | `[]` | CIDRs allowed to SSH (empty = no SSH) |
| `worker_shared_secret` | Yes | — | Shared secret (sensitive) |
| `convex_url` | Yes | — | Convex deployment URL |
| `root_volume_size_gb` | No | `200` | Root EBS volume size in GB |
| `max_dev_vms` | No | `10` | Max concurrent dev VMs per worker |
| `warm_pool_size` | No | `2` | Warm VMs per language |
| `max_warm_vms` | No | `4` | Max total warm VMs |
| `worker_concurrency` | No | `2` | Parallel BullMQ jobs per worker |
| `workspace_idle_timeout_ms` | No | `1800000` | Idle timeout in ms |
| `firecracker_version` | No | `1.7.0` | Firecracker release version |
| `node_version` | No | `20` | Node.js major version |
| `harden_egress` | No | `true` | Enable egress filtering |
| `enable_sonarqube` | No | `false` | Deploy SonarQube + Postgres sidecars on worker hosts |
| `sonarqube_url` | No | `""` | SonarQube endpoint passed to worker env (`https://...` recommended for hardened/prod) |
| `sonarqube_token` | No | `""` | SonarQube auth token passed to worker env |
| `snyk_token` | No | `""` | Snyk token passed to worker env |

### Convex environment variables

These must be set in the Convex dashboard (or via `npx convex env set`):

| Variable | Description |
|----------|-------------|
| `WORKER_API_URL` | Worker URL from `terraform output worker_host_urls` (e.g. `http://<eip>:3001`) |
| `WORKER_SHARED_SECRET` | Same value as in `terraform.tfvars` |

## Provisioning Scripts Reference

All scripts are in `infra/aws/scripts/` and deployed to `/opt/arcagent/scripts/` on the host.

| Script | Purpose |
|--------|---------|
| `setup-host.sh` | Main user-data script. Installs all dependencies, configures KVM/networking, writes `worker.env`, sets up systemd service. Idempotent. |
| `setup-worker.sh` | Creates the `arcagent-worker` systemd service, log rotation config, and `deploy.sh` helper. |
| `install-firecracker.sh` | Downloads and installs Firecracker + jailer binaries. Usage: `bash install-firecracker.sh [VERSION]` |
| `build-rootfs.sh` | Builds ext4 rootfs images for 6 languages: Node.js 20, Python 3.12, Rust stable, Go 1.22, Java 21, and a base image. Images stored in `/var/lib/firecracker/rootfs/`. Additional languages in `vmConfig.ts` (Ruby, PHP, C/C++, C#, Swift, Kotlin) require manually building their rootfs images. |
| `detect-host-url.sh` | Runs as `ExecStartPre` before every worker start. Detects the public IP via IMDSv2 and updates `WORKER_HOST_URL` in `worker.env`. |
