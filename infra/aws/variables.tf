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
  description = "EC2 instance type — must be .metal for KVM/Firecracker support"
  type        = string
  default     = "c6i.metal"

  validation {
    condition     = can(regex("\\.metal$", var.instance_type))
    error_message = "Instance type must be a .metal variant for KVM support."
  }
}

variable "worker_count" {
  description = "Number of worker instances to deploy"
  type        = number
  default     = 1
}

variable "allocate_eip" {
  description = "Allocate and attach Elastic IPs to workers. Disable when EIP quota is exhausted."
  type        = bool
  default     = true
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
  description = "Root EBS volume size in GB (stores rootfs images, overlays, etc.)"
  type        = number
  default     = 200
}

variable "max_dev_vms" {
  description = "Maximum concurrent development VMs per worker"
  type        = number
  default     = 10
}

variable "warm_pool_size" {
  description = "Number of warm VMs to keep per language"
  type        = number
  default     = 2
}

variable "max_warm_vms" {
  description = "Maximum total warm VMs across all languages"
  type        = number
  default     = 4
}

variable "firecracker_version" {
  description = "Firecracker release version to install"
  type        = string
  default     = "1.10.1"
}

variable "node_version" {
  description = "Node.js major version to install"
  type        = string
  default     = "20"
}

variable "harden_egress" {
  description = "Enable hardened egress filtering (DNS resolver + SNI proxy)"
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
  description = "Version tag for pre-built rootfs images in S3 (e.g. v1, v2)"
  type        = string
  default     = "v1"
}

variable "rootfs_upload_on_boot" {
  description = "When true, upload locally-built rootfs images to S3 cache if missing."
  type        = bool
  default     = true
}

variable "worker_artifact_s3_key" {
  description = "Optional S3 key for a worker build tarball (dist + package files) in the rootfs bucket."
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
  description = "Public Route53 hosted zone name for worker DNS (for example speedlesvc.com)."
  type        = string
  default     = ""
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
