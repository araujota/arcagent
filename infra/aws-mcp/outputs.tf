output "alb_dns_name" {
  description = "ALB DNS name (set this as Vercel CNAME target for mcp.arcagent.dev)"
  value       = aws_lb.mcp.dns_name
}

output "alb_zone_id" {
  description = "ALB hosted zone ID"
  value       = aws_lb.mcp.zone_id
}

output "mcp_public_url" {
  description = "Public MCP URL"
  value       = "https://${var.mcp_public_domain}"
}

output "worker_proxy_public_url" {
  description = "Public MCP worker-proxy base URL (set this as Convex WORKER_API_URL)"
  value       = "https://${var.mcp_public_domain}${local.worker_proxy_path_prefix}"
}

output "vercel_cname_record" {
  description = "Vercel DNS CNAME instructions"
  value = {
    name  = var.mcp_public_domain
    type  = "CNAME"
    value = aws_lb.mcp.dns_name
  }
}

output "acm_certificate_arn" {
  description = "Certificate ARN used by ALB HTTPS listener"
  value       = local.certificate_arn
}

output "acm_dns_validation_records" {
  description = "Add these CNAMEs in Vercel DNS to validate ACM certificate"
  value = local.request_certificate ? [for option in aws_acm_certificate.mcp[0].domain_validation_options : {
    domain_name  = option.domain_name
    record_name  = option.resource_record_name
    record_type  = option.resource_record_type
    record_value = option.resource_record_value
  }] : []
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.mcp.name
}

output "ecs_service_name" {
  description = "ECS service name"
  value       = aws_ecs_service.mcp.name
}

output "vpc_id" {
  description = "MCP VPC ID"
  value       = aws_vpc.mcp.id
}

output "vpc_cidr" {
  description = "MCP VPC CIDR"
  value       = aws_vpc.mcp.cidr_block
}

output "private_route_table_id" {
  description = "MCP private route table ID"
  value       = aws_route_table.private.id
}

output "redis_primary_endpoint" {
  description = "ElastiCache Redis primary endpoint"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "redis_reader_endpoint" {
  description = "ElastiCache Redis reader endpoint"
  value       = aws_elasticache_replication_group.redis.reader_endpoint_address
}
