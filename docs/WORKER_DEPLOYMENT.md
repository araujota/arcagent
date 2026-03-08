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
                              │  │  Process backend sandbox     │    │
                              │  │  - Isolated workspace dirs   │    │
                              │  │  - Unprivileged exec user    │    │
                              │  │  - Per-job cleanup           │    │
                              │  │  - Secret-scrubbed env       │    │
                              │  └──────────────────────────────┘    │
                              └──────────────────────────────────────┘
```

**Key points:**
- The worker is independently deployed — it runs on your own infrastructure, not alongside Convex
- The worker runs in API-only mode (`WORKER_ROLE=api`) and still processes BullMQ verification jobs.
- Workspace/job execution is performed by this worker instance (or its configured execution backend), so each worker can provision and own multiple workspaces.
- Requires **Redis** for the BullMQ job queue
- Process backend is the default runtime and executes jobs as an unprivileged host user
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

The worker's generic `sonar-scanner` path is hardened for TypeScript/JavaScript, Python, Go, Java/Kotlin, Ruby, PHP, and Rust. .NET and C/C++/Swift require language-specific scanner flows or build-wrapper support and should remain disabled until that tooling is provisioned.

### Environment variables

Create a `.env` file at the repo root (loaded by all services via `env_file`). Reference `worker/.env.example` for the full list. The critical variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `CONVEX_URL` | Yes | Convex deployment URL (e.g. `https://your-app.convex.cloud`) |
| `CONVEX_HTTP_ACTIONS_URL` | Recommended | Convex HTTP actions URL (e.g. `https://your-app.convex.site`) |
| `WORKER_SHARED_SECRET` | Yes | Must match the value set in Convex env |
| `WORKER_ROLE` | No | Runtime role (`api`) |
| `REDIS_URL` | No | Overridden to `redis://redis:6379` by Docker Compose |
| `PORT` | No | Default: `3001` |
| `WORKSPACE_ISOLATION_MODE` | No | `shared_worker` (default) |

### Process Backend in Docker

Run the worker with the process backend in both local and production-style environments.

```bash
WORKER_EXECUTION_BACKEND=process
cd worker && npm run dev
```

This starts the Express server in API mode and provisions workspaces on this worker when enabled by runtime configuration.

### Pulling worker envs from Vercel before local deploy

From repo root:

```bash
npm run env:sync:worker
```

This generates `worker/.env.generated` (gitignored, mode `0600`) and overlays it on top of `worker/.env` in both root and worker `docker compose` configurations.

## Production Deployment to AWS (Terraform)

The `infra/aws/` directory contains Terraform configuration for deploying worker hosts on AWS.

### Prerequisites

- AWS CLI configured with appropriate credentials
- Terraform >= 1.5
- An EC2 key pair created in your target region
- Your Convex deployment URL and shared secret

### Infrastructure overview

Terraform provisions:
- **VPC** (`10.1.0.0/16`) with public subnets for worker hosts
- **EC2 Auto Scaling Group** for worker hosts (target-tracking on CPU)
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

# Use a small baseline worker shape and autoscaling by capacity.
instance_type = "t3.micro"
worker_role   = "api"
ssh_key_name  = "your-key-pair-name"
enable_autoscaling   = true
asg_min_size         = 1
asg_desired_capacity = 1
asg_max_size         = 6
asg_cpu_target_utilization = 60

# Recommended in autoscaling mode to preserve an existing stable URL.
# If omitted, Terraform uses the ALB DNS name as WORKER_API_URL.
worker_public_url = "http://arcagent.speedlesvc.com:3001"

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
worker_host_urls             = ["http://arcagent.speedlesvc.com:3001"]
worker_autoscaling_group_name = "arcagent-worker-production"
worker_alb_dns_name           = "arcagent-worker-production-123456.us-east-1.elb.amazonaws.com"
```

#### 3. Copy provisioning scripts to the host

The `setup-host.sh` script runs as user-data on first boot but needs the helper scripts:

```bash
scp -i <key.pem> infra/aws/scripts/* ubuntu@<worker-host>:/opt/arcagent/scripts/
```

If the scripts weren't present during first boot, re-run setup:

```bash
ssh -i <key.pem> ubuntu@<worker-host> 'sudo bash /var/lib/cloud/instance/user-data.txt'
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
scp -i <key.pem> worker-build.tar.gz ubuntu@<worker-host>:/tmp/
ssh -i <key.pem> ubuntu@<worker-host> 'sudo bash /opt/arcagent/deploy.sh /tmp/worker-build.tar.gz'
```

The `deploy.sh` script (created by `setup-worker.sh`) stops the service, extracts the archive, runs `npm ci --production`, and restarts the service.
The `deploy.sh` script now stages the release first, pauses queue intake, waits for active verification jobs to drain, performs an atomic directory swap, restarts quickly, health-checks, and resumes queue intake:

```bash
sudo bash /opt/arcagent/deploy.sh /tmp/worker-build.tar.gz 1800
```

#### 5. Set worker endpoints in Convex

```bash
npx convex env set WORKER_API_URL "http://arcagent.speedlesvc.com:3001"
```

Ensure `WORKER_SHARED_SECRET` is also set in Convex to the same value as in `terraform.tfvars`.

#### 6. Verify

```bash
curl http://arcagent.speedlesvc.com:3001/api/health
# Expected: {"status":"ok","timestamp":"..."}
```

## Scaling

### Horizontal scaling (automatic)

Autoscaling is enabled by default. Tune these values in `terraform.tfvars`:

```hcl
enable_autoscaling = true
asg_min_size = 1
asg_desired_capacity = 1
asg_max_size = 6
asg_cpu_target_utilization = 60
```

Run `terraform apply`. The ASG scales worker count up/down around your CPU target.

> **Note:** The default setup uses a local Redis per host. For multi-host horizontal scaling, you need a shared Redis instance (e.g. Amazon ElastiCache). Update `REDIS_URL` in `/opt/arcagent/worker.env` on each host to point to the shared Redis.

### Vertical scaling (bigger/smaller node shape)

Adjust these variables in `terraform.tfvars`:

| Variable | Default | Description |
|----------|---------|-------------|
| `instance_type` | `t3.micro` | Per-node EC2 size for each worker in the ASG |
| `worker_concurrency` | `2` | Parallel BullMQ verification jobs per instance |
| `max_dev_vms` | `10` | Maximum concurrent development workspaces |
| `warm_pool_size` | `0` | Legacy firecracker warm pool setting (recommend `0` for process backend) |
| `max_warm_vms` | `0` | Legacy firecracker warm pool cap (recommend `0` for process backend) |

The BullMQ worker also enforces a rate limit of **10 jobs per minute** per instance (configurable in `worker/src/queue/jobQueue.ts`).

### Language Execution Profiles

Language defaults still come from `worker/src/vm/vmConfig.ts` and are used for gate timeout/capacity planning.
For process backend sizing, plan around host CPU/RAM, `WORKER_CONCURRENCY`, and expected build/test workload mix.

## Updating / Redeploying

### Option A: Build locally, deploy via scp

```bash
# On your build machine
cd worker
npm run build
tar czf worker-build.tar.gz dist/ package.json package-lock.json

# Deploy to host
scp -i <key.pem> worker-build.tar.gz ubuntu@<worker-host>:/tmp/
ssh -i <key.pem> ubuntu@<worker-host> 'sudo bash /opt/arcagent/deploy.sh /tmp/worker-build.tar.gz'
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
curl http://arcagent.speedlesvc.com:3001/api/health
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
| `Redis connection refused` | Runtime sidecar not running | `sudo systemctl restart arcagent-runtime-stack` then `docker ps` |
| `runuser binary is required` | Missing util-linux package in image/host | Install `util-linux` (provides `runuser`) and restart worker |
| `Process backend execution user 'agent' does not exist` | Host bootstrap did not create the execution user | Re-run `setup-host.sh` or create user: `sudo useradd -m -s /bin/bash -U agent` |
| `WORKER_API_URL` changed unexpectedly | `worker_public_url` not pinned, so output followed ALB DNS changes | Set `worker_public_url` in `terraform.tfvars` to pin a stable URL and re-apply |
| `401 Unauthorized` from Convex | `WORKER_SHARED_SECRET` mismatch | Ensure the secret in `/opt/arcagent/worker.env` matches the Convex env var |
| Worker starts but jobs fail | Missing language/scanner tooling on host | Check setup log and rerun bootstrap: `sudo bash /var/lib/cloud/instance/user-data.txt` |

## Security Considerations

### Authentication

- **`WORKER_SHARED_SECRET`** authenticates all Convex-to-worker and worker-to-Convex communication. It must match on both sides. Comparison uses constant-time equality (SECURITY H3).
- The health endpoint (`GET /api/health`) is intentionally unauthenticated. All other `/api/*` routes require the shared secret in the `Authorization` header.

### Instance hardening

- **IMDSv2 enforced** — `http_tokens = "required"` in the EC2 metadata options prevents SSRF-based credential theft via IMDSv1.
- **Encrypted EBS** — root volumes use `encrypted = true`.
- **SSH restricted** — only allowed from CIDRs specified in `ssh_allowed_cidrs`. Leave empty to disable SSH entirely (use SSM Session Manager instead).

### Execution hardening

Process backend hardening defaults:
- Commands run as unprivileged `agent` user (via `runuser`)
- Child process environments are scrubbed of worker secrets
- Workspace paths are isolated to per-job temp directories
- Metadata endpoint access is blocked for the execution user (`169.254.169.254`)

### Why root?

The worker systemd service runs as `root` because it needs to:
- Set up and persist host firewall rules for metadata hardening
- Create/chown execution workspaces and drop privileges with `runuser`
- Manage runtime sidecars and worker service lifecycle

User code still runs as an unprivileged `agent` user.

## Environment Variable Reference

### Worker environment (`worker/.env.example`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CONVEX_URL` | Yes | — | Convex deployment URL |
| `CONVEX_HTTP_ACTIONS_URL` | No | derived from `CONVEX_URL` | Convex HTTP actions URL for `/api/*` callbacks |
| `WORKER_SHARED_SECRET` | Yes | — | Shared secret (must match Convex env) |
| `WORKER_ROLE` | No | `api` | Runtime role |
| `WORKER_EXECUTION_BACKEND` | No | `process` | Execution backend for worker-owned workspaces (`process` recommended, `firecracker` legacy) |
| `REDIS_URL` | Yes | `redis://localhost:6379` | Redis connection URL |
| `PORT` | No | `3001` | Server port |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `WORKER_HOST_URL` | No | Auto-detected | Public URL of this worker instance |
| `MAX_DEV_VMS` | No | `10` | Maximum concurrent development workspaces |
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
| `instance_type` | No | `t3.micro` | EC2 instance type for worker hosts |
| `enable_autoscaling` | No | `true` | Enable worker Auto Scaling Group |
| `asg_min_size` | No | `1` | Minimum worker instances in ASG |
| `asg_desired_capacity` | No | `1` | Desired worker instances in ASG |
| `asg_max_size` | No | `6` | Maximum worker instances in ASG |
| `asg_cpu_target_utilization` | No | `60` | Target average CPU percent for ASG target-tracking |
| `worker_count` | No | `1` | Number of worker instances when autoscaling is disabled |
| `worker_role` | No | `api` | Worker runtime role (API-only deployment) |
| `ssh_key_name` | Yes | — | EC2 key pair name |
| `ssh_allowed_cidrs` | No | `[]` | CIDRs allowed to SSH (empty = no SSH) |
| `worker_shared_secret` | Yes | — | Shared secret (sensitive) |
| `convex_url` | Yes | — | Convex deployment URL |
| `root_volume_size_gb` | No | `100` | Root EBS volume size in GB |
| `max_dev_vms` | No | `10` | Max concurrent development workspaces per worker |
| `warm_pool_size` | No | `0` | Legacy firecracker warm pool setting (keep `0` for process backend) |
| `max_warm_vms` | No | `0` | Legacy firecracker warm pool cap (keep `0` for process backend) |
| `worker_concurrency` | No | `2` | Parallel BullMQ jobs per worker |
| `workspace_idle_timeout_ms` | No | `1800000` | Idle timeout in ms |
| `node_version` | No | `20` | Node.js major version |
| `enable_sonarqube` | No | `false` | Deploy SonarQube + Postgres sidecars on worker hosts |
| `sonarqube_url` | No | `""` | SonarQube endpoint passed to worker env (`https://...` recommended for hardened/prod) |
| `sonarqube_token` | No | `""` | SonarQube auth token passed to worker env |
| `snyk_token` | No | `""` | Snyk token passed to worker env |
| `worker_public_url` | No | `""` | Optional pinned public worker URL for all ASG instances (otherwise ALB DNS is used) |

### Convex environment variables

These must be set in the Convex dashboard (or via `npx convex env set`):

| Variable | Description |
|----------|-------------|
| `WORKER_API_URL` | Stable worker URL from `terraform output worker_host_urls` (for example `http://arcagent.speedlesvc.com:3001`) |
| `WORKER_SHARED_SECRET` | Same value as in `terraform.tfvars` |

## Provisioning Scripts Reference

All scripts are in `infra/aws/scripts/` and deployed to `/opt/arcagent/scripts/` on the host.

| Script | Purpose |
|--------|---------|
| `setup-host.sh` | Main user-data script. Installs process-backend dependencies, configures runtime sidecars, writes `worker.env`, and sets up systemd service. Idempotent. |
| `setup-worker.sh` | Creates the `arcagent-worker` systemd service, log rotation config, and `deploy.sh` helper. |
| `detect-host-url.sh` | Runs as `ExecStartPre` before every worker start. Detects the public IP via IMDSv2 and updates `WORKER_HOST_URL` in `worker.env`. |
