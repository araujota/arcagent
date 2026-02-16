# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "worker_public_ips" {
  description = "Public IP addresses of worker instances"
  value       = aws_eip.worker[*].public_ip
}

output "worker_instance_ids" {
  description = "EC2 instance IDs"
  value       = aws_instance.worker[*].id
}

output "worker_host_urls" {
  description = "WORKER_HOST_URL values — set these in Convex environment"
  value       = [for eip in aws_eip.worker : "http://${eip.public_ip}:3001"]
}

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.worker.id
}

output "security_group_id" {
  description = "Worker security group ID"
  value       = aws_security_group.worker.id
}

output "ssh_command" {
  description = "SSH command template"
  value       = length(aws_eip.worker) > 0 ? "ssh -i <key.pem> ubuntu@${aws_eip.worker[0].public_ip}" : "No workers deployed"
}
