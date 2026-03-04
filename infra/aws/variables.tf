# ---------------------------------------------------------------------------
# Input variables
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name (e.g. production, staging)"
  type        = string
  default     = "production"
}

variable "instance_type" {
  description = "EC2 instance type for the worker host"
  type        = string
  default     = "t3.micro"
}

variable "worker_count" {
  description = "Number of worker instances to deploy when autoscaling is disabled"
  type        = number
  default     = 1
}

variable "enable_autoscaling" {
  description = "Enable EC2 Auto Scaling Group for worker hosts"
  type        = bool
  default     = true
}

variable "create_nat_gateway" {
  description = "Create NAT gateway + EIP for private-subnet egress (required for GitHub/package-manager access from worker/workspaces)."
  type        = bool
  default     = true
}

variable "asg_min_size" {
  description = "Minimum worker instance count when autoscaling is enabled"
  type        = number
  default     = 1
}

variable "asg_max_size" {
  description = "Maximum worker instance count when autoscaling is enabled"
  type        = number
  default     = 6
}

variable "asg_desired_capacity" {
  description = "Desired worker instance count when autoscaling is enabled"
  type        = number
  default     = 1
}

variable "asg_cpu_target_utilization" {
  description = "Target average CPU utilization for worker ASG target tracking"
  type        = number
  default     = 60
}

variable "asg_scale_in_cooldown_seconds" {
  description = "Scale-in cooldown for worker ASG target tracking policy"
  type        = number
  default     = 180
}

variable "asg_scale_out_cooldown_seconds" {
  description = "Scale-out cooldown for worker ASG target tracking policy"
  type        = number
  default     = 60
}

variable "worker_role" {
  description = "Worker runtime role (api)"
  type        = string
  default     = "api"

  validation {
    condition     = var.worker_role == "api"
    error_message = "worker_role must be set to \"api\"."
  }
}

variable "allocate_eip" {
  description = "Allocate and attach Elastic IPs to workers. Only supported when create_nat_gateway=false."
  type        = bool
  default     = false
}

variable "ssh_key_name" {
  description = "Name of an existing EC2 key pair for SSH access"
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "CIDR blocks allowed to SSH into worker instances"
  type        = list(string)
  default     = []
}

variable "worker_api_allowed_cidrs" {
  description = "CIDR ranges allowed to reach the worker ALB listener."
  type        = list(string)
  default     = []
}

variable "worker_shared_secret" {
  description = "Shared secret for Convex ↔ Worker authentication (WORKER_SHARED_SECRET)"
  type        = string
  sensitive   = true
}

variable "convex_url" {
  description = "Convex deployment URL (e.g. https://your-app.convex.cloud)"
  type        = string
}

variable "convex_http_actions_url" {
  description = "Convex HTTP actions URL (e.g. https://your-app.convex.site). If empty, derived from convex_url."
  type        = string
  default     = ""
}

variable "root_volume_size_gb" {
  description = "Root EBS volume size in GB (stores repos, build artifacts, and runtime data)"
  type        = number
  default     = 100
}

variable "max_dev_vms" {
  description = "Maximum concurrent development workspaces per worker"
  type        = number
  default     = 10
}

variable "warm_pool_size" {
  description = "Legacy warm pool size setting (used only by firecracker backend)"
  type        = number
  default     = 2
}

variable "max_warm_vms" {
  description = "Legacy max warm pool setting (used only by firecracker backend)"
  type        = number
  default     = 4
}

variable "firecracker_version" {
  description = "Deprecated no-op (kept for backward compatibility with older tfvars)"
  type        = string
  default     = "1.10.1"
}

variable "node_version" {
  description = "Node.js major version to install"
  type        = string
  default     = "20"
}

variable "harden_egress" {
  description = "Deprecated no-op (kept for backward compatibility with older tfvars)"
  type        = bool
  default     = true
}

variable "worker_concurrency" {
  description = "Number of parallel BullMQ verification jobs per worker"
  type        = number
  default     = 2
}

variable "workspace_idle_timeout_ms" {
  description = "Idle workspace timeout in milliseconds (default 30 min)"
  type        = number
  default     = 1800000
}

variable "rootfs_version" {
  description = "Deprecated no-op (kept for backward compatibility with older tfvars)"
  type        = string
  default     = "v1"
}

variable "rootfs_upload_on_boot" {
  description = "Deprecated no-op (kept for backward compatibility with older tfvars)"
  type        = bool
  default     = true
}

variable "worker_artifact_s3_key" {
  description = "Optional S3 key for a worker build tarball (dist + package files) in the artifact bucket."
  type        = string
  default     = ""
}

variable "enable_sonarqube" {
  description = "Deploy SonarQube + Postgres containers on the worker host."
  type        = bool
  default     = false
}

variable "sonarqube_url" {
  description = "Optional SonarQube URL for worker gate execution. Use an HTTPS URL reachable from execution environments."
  type        = string
  default     = ""
}

variable "sonarqube_token" {
  description = "SonarQube authentication token for gate execution."
  type        = string
  default     = ""
  sensitive   = true
}

variable "snyk_token" {
  description = "Snyk API token used by the Snyk gate."
  type        = string
  default     = ""
  sensitive   = true
}

variable "route53_zone_name" {
  description = "Route53 hosted zone name for worker DNS."
  type        = string
  default     = ""
}

variable "route53_private_zone" {
  description = "Set true when route53_zone_name refers to a private hosted zone."
  type        = bool
  default     = false
}

variable "worker_dns_name" {
  description = "FQDN to point at the primary worker public IP (for example arcagent.speedlesvc.com)."
  type        = string
  default     = ""
}

variable "worker_public_url" {
  description = "Optional fixed public worker base URL (for example http://arcagent.speedlesvc.com:3001). When set, host auto-detection is disabled."
  type        = string
  default     = ""
}

variable "mcp_vpc_id" {
  description = "Optional MCP VPC ID for private peering to the worker VPC."
  type        = string
  default     = ""
}

variable "mcp_vpc_cidr" {
  description = "Optional MCP VPC CIDR block for worker<->MCP private routing."
  type        = string
  default     = ""
}

variable "mcp_private_route_table_ids" {
  description = "Optional list of MCP private route table IDs to update with worker VPC peering routes."
  type        = list(string)
  default     = []
}
