variable "aws_region" {
  description = "AWS region for MCP hosting"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

variable "name_prefix" {
  description = "Prefix for AWS resources"
  type        = string
  default     = "arcagent-mcp"
}

variable "vpc_cidr" {
  description = "CIDR block for MCP VPC"
  type        = string
  default     = "10.60.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDRs for ALB and NAT"
  type        = list(string)
  default     = ["10.60.0.0/24", "10.60.1.0/24"]
}

variable "private_subnet_cidrs" {
  description = "Private subnet CIDRs for ECS tasks and Redis"
  type        = list(string)
  default     = ["10.60.10.0/24", "10.60.11.0/24"]
}

variable "use_nat_gateway" {
  description = "Create NAT gateway + EIP for private-subnet egress."
  type        = bool
  default     = true
}

variable "container_image" {
  description = "Container image for MCP server"
  type        = string
}

variable "container_port" {
  description = "MCP server container port"
  type        = number
  default     = 3002
}

variable "cpu" {
  description = "Fargate task CPU units"
  type        = number
  default     = 512
}

variable "memory" {
  description = "Fargate task memory in MiB"
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Desired ECS service task count"
  type        = number
  default     = 1
}

variable "min_count" {
  description = "Minimum ECS service task count for autoscaling"
  type        = number
  default     = 1
}

variable "max_count" {
  description = "Maximum ECS service task count for autoscaling"
  type        = number
  default     = 6
}

variable "cpu_target_utilization" {
  description = "Target ECS CPU utilization percentage for target-tracking autoscaling"
  type        = number
  default     = 60
}

variable "alb_requests_per_target" {
  description = "Target ALB requests per task for target-tracking autoscaling"
  type        = number
  default     = 120
}

variable "autoscaling_scale_in_cooldown_seconds" {
  description = "Scale-in cooldown for ECS autoscaling policies"
  type        = number
  default     = 120
}

variable "autoscaling_scale_out_cooldown_seconds" {
  description = "Scale-out cooldown for ECS autoscaling policies"
  type        = number
  default     = 60
}

variable "enable_autoscaling" {
  description = "Enable ECS target-tracking autoscaling"
  type        = bool
  default     = true
}

variable "mcp_public_domain" {
  description = "Public DNS name for hosted MCP endpoint"
  type        = string
  default     = "mcp.arcagent.dev"
}

variable "worker_internal_url" {
  description = "Private worker base URL reachable from MCP tasks (for example http://internal-worker-alb-xxx.us-east-1.elb.amazonaws.com:3001)."
  type        = string
  default     = ""
}

variable "worker_vpc_cidr" {
  description = "Optional worker VPC CIDR to allow MCP task egress to private worker endpoints."
  type        = string
  default     = ""
}

variable "worker_proxy_path_prefix" {
  description = "Public path prefix on MCP used to proxy authenticated worker API calls."
  type        = string
  default     = "/worker-proxy"
}

variable "alb_ingress_allowed_cidrs" {
  description = "CIDR ranges allowed to reach the public MCP ALB."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "acm_certificate_arn" {
  description = "Existing ACM certificate ARN for the public domain. Leave empty to request one."
  type        = string
  default     = ""
}

variable "request_acm_certificate" {
  description = "Request a new ACM certificate when acm_certificate_arn is not provided"
  type        = bool
  default     = true
}

variable "convex_http_actions_url" {
  description = "Convex HTTP actions URL (.convex.site)"
  type        = string
}

variable "session_mode" {
  description = "MCP session mode (stateful for ALB stickiness phase; stateless for phase B)"
  type        = string
  default     = "stateful"

  validation {
    condition     = contains(["stateful", "stateless"], var.session_mode)
    error_message = "session_mode must be either stateful or stateless"
  }
}

variable "register_honeypot_field" {
  description = "Registration honeypot field name"
  type        = string
  default     = "website"
}

variable "mcp_json_body_limit" {
  description = "Express JSON body limit"
  type        = string
  default     = "1mb"
}

variable "enable_convex_audit_logs" {
  description = "Mirror MCP audit logs to Convex"
  type        = bool
  default     = true
}

variable "worker_shared_secret_secret_arn" {
  description = "Secrets Manager ARN containing WORKER_SHARED_SECRET"
  type        = string
}

variable "mcp_audit_log_token_secret_arn" {
  description = "Secrets Manager ARN containing MCP_AUDIT_LOG_TOKEN"
  type        = string
}

variable "register_captcha_secret_arn" {
  description = "Optional Secrets Manager ARN containing MCP_REGISTER_CAPTCHA_SECRET"
  type        = string
  default     = ""
}

variable "register_captcha_header" {
  description = "Header name for registration captcha token"
  type        = string
  default     = "x-arcagent-captcha-token"
}

variable "redis_node_type" {
  description = "ElastiCache Redis node type"
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_engine_version" {
  description = "ElastiCache Redis engine version"
  type        = string
  default     = "7.1"
}

variable "redis_num_cache_clusters" {
  description = "Number of cache nodes in replication group"
  type        = number
  default     = 2
}

variable "log_retention_days" {
  description = "CloudWatch log retention"
  type        = number
  default     = 30
}

variable "enable_waf" {
  description = "Attach an existing WAFv2 Web ACL to the ALB"
  type        = bool
  default     = false
}

variable "waf_web_acl_arn" {
  description = "Existing WAFv2 Web ACL ARN"
  type        = string
  default     = ""
}
