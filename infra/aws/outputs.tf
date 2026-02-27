# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

locals {
  worker_public_ips = var.allocate_eip ? aws_eip.worker[*].public_ip : aws_instance.worker[*].public_ip
}

output "worker_public_ips" {
  description = "Public IP addresses of worker instances"
  value       = local.worker_public_ips
}

output "worker_instance_ids" {
  description = "EC2 instance IDs"
  value       = aws_instance.worker[*].id
}

output "worker_host_urls" {
  description = "WORKER_HOST_URL values — set these in Convex environment"
  value       = [for ip in local.worker_public_ips : "http://${ip}:3001"]
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
  description = "Public subnet IDs in the worker VPC"
  value       = aws_subnet.worker[*].id
}

output "security_group_id" {
  description = "Worker security group ID"
  value       = aws_security_group.worker.id
}

output "ssh_command" {
  description = "SSH command template"
  value       = length(local.worker_public_ips) > 0 ? "ssh -i <key.pem> ubuntu@${local.worker_public_ips[0]}" : "No workers deployed"
}

output "rootfs_bucket" {
  description = "S3 bucket for pre-built rootfs images"
  value       = aws_s3_bucket.rootfs.id
}
