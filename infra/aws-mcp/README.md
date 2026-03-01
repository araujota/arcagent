# AWS Hosted MCP (ECS Fargate)

This stack deploys the Arcagent MCP server for operator-hosted access at `https://mcp.arcagent.dev` while keeping `arcagent.dev` DNS ownership on Vercel.

For remote MCP client configuration, use `https://mcp.arcagent.dev` as the MCP server URL.

## What it deploys

- VPC with public + private subnets
- Internet Gateway + NAT Gateway
- Public ALB with:
  - `80 -> 443` redirect
  - HTTPS listener (ACM cert)
- ECS Fargate service (default desired count: 1)
- ElastiCache Redis (for distributed MCP rate limiting)
- CloudWatch log group
- Optional WAF association (existing Web ACL)
- ECS autoscaling target tracking:
  - CPU utilization target
  - ALB requests-per-target target

## Prerequisites

- AWS credentials with permissions for VPC, ECS, ELBv2, ACM, ElastiCache, IAM, CloudWatch, and optional WAF
- Terraform >= 1.5
- Vercel DNS control for `arcagent.dev`
- Existing Secrets Manager secrets:
  - `WORKER_SHARED_SECRET`
  - `MCP_AUDIT_LOG_TOKEN`
  - optional `MCP_REGISTER_CAPTCHA_SECRET`

## Deploy

```bash
cd infra/aws-mcp
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars
terraform init
terraform plan
terraform apply
```

## DNS + TLS (no domain transfer)

This stack supports two certificate paths:

1. Bring existing ACM cert via `acm_certificate_arn`.
2. Request new cert by keeping `request_acm_certificate=true`.

If requesting a new cert:

1. Run `terraform apply`.
2. Copy `acm_dns_validation_records` output.
3. Add each CNAME in Vercel DNS.
4. Wait for ACM certificate status to become `ISSUED`.

Then set Vercel DNS record:

- `mcp.arcagent.dev` CNAME -> `alb_dns_name` output

## Runtime defaults encoded in task env

- `MCP_TRANSPORT=http`
- `MCP_PUBLIC_BASE_URL=https://mcp.arcagent.dev`
- `MCP_ALLOWED_HOSTS=mcp.arcagent.dev`
- `MCP_REQUIRE_HTTPS=true`
- `MCP_SESSION_MODE=stateful` (phase A)
- `RATE_LIMIT_STORE=redis`
- `RATE_LIMIT_REDIS_URL=redis://...`

## Phase migration

- Phase A: keep `session_mode = "stateful"` with ALB cookie stickiness enabled in target group.
- Phase B: set `session_mode = "stateless"`, re-apply, and canary clients.

## Autoscaling defaults

- `desired_count = 1`
- `min_count = 1`
- `max_count = 6`
- `cpu_target_utilization = 60`
- `alb_requests_per_target = 120`

This keeps the service at the minimum baseline when idle and scales out as load increases.

## Important outputs

- `vercel_cname_record`
- `acm_dns_validation_records`
- `mcp_public_url`
- `redis_primary_endpoint`
- `ecs_cluster_name`, `ecs_service_name`
