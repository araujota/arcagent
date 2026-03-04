# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

locals {
  worker_public_ips = compact(var.enable_autoscaling ? [] : (var.allocate_eip ? aws_eip.worker[*].public_ip : aws_instance.worker[*].public_ip))
}

output "worker_public_ips" {
  description = "Public IP addresses of worker instances"
  value       = local.worker_public_ips
}

output "worker_instance_ids" {
  description = "EC2 instance IDs"
  value       = var.enable_autoscaling ? [] : aws_instance.worker[*].id
}

output "worker_autoscaling_group_name" {
  description = "Worker Auto Scaling Group name (empty when autoscaling is disabled)"
  value       = var.enable_autoscaling ? aws_autoscaling_group.worker[0].name : ""
}

output "worker_alb_dns_name" {
  description = "Worker internal ALB DNS name (empty when autoscaling is disabled)"
  value       = var.enable_autoscaling ? aws_lb.worker[0].dns_name : ""
}

output "worker_host_urls" {
  description = "Worker URL(s) advertised to callers (set worker_public_url to MCP proxy URL for private workers)"
  value       = var.enable_autoscaling ? [local.worker_public_url_effective] : (trimspace(var.worker_public_url) != "" ? [trimspace(var.worker_public_url)] : [for ip in local.worker_public_ips : "http://${ip}:3001"])
}

output "worker_dns_url" {
  description = "Stable DNS URL for MCP -> worker communication (if configured)"
  value       = trimspace(var.worker_dns_name) != "" ? "http://${trimspace(var.worker_dns_name)}:3001" : ""
}

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.worker.id
}

output "worker_subnet_ids" {
  description = "Private subnet IDs in the worker VPC"
  value       = aws_subnet.worker[*].id
}

output "worker_public_subnet_ids" {
  description = "Public ingress/NAT subnet IDs in the worker VPC"
  value       = aws_subnet.public[*].id
}

output "security_group_id" {
  description = "Worker security group ID"
  value       = aws_security_group.worker.id
}

output "ssh_command" {
  description = "SSH command template (only available when workers have public IPs)"
  value       = (!var.enable_autoscaling && length(local.worker_public_ips) > 0) ? "ssh -i <key.pem> ubuntu@${local.worker_public_ips[0]}" : "Workers are private by default; use SSM Session Manager or private network access"
}

output "rootfs_bucket" {
  description = "S3 bucket for worker bootstrap scripts and artifacts (legacy output name)"
  value       = aws_s3_bucket.rootfs.id
}

output "worker_internal_url" {
  description = "Private worker base URL (for MCP private routing/proxy target)"
  value       = var.enable_autoscaling ? "http://${aws_lb.worker[0].dns_name}:3001" : ""
}

output "mcp_vpc_peering_connection_id" {
  description = "VPC peering connection ID to MCP VPC (empty when peering is disabled)"
  value       = length(aws_vpc_peering_connection.mcp) > 0 ? aws_vpc_peering_connection.mcp[0].id : ""
}
