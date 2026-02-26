# ---------------------------------------------------------------------------
# Optional DNS record for stable worker endpoint
# ---------------------------------------------------------------------------

locals {
  create_worker_dns_record = trimspace(var.route53_zone_name) != "" && trimspace(var.worker_dns_name) != "" && var.worker_count > 0
}

data "aws_route53_zone" "worker" {
  count        = local.create_worker_dns_record ? 1 : 0
  name         = "${trimspace(var.route53_zone_name)}."
  private_zone = false
}

resource "aws_route53_record" "worker" {
  count = local.create_worker_dns_record ? 1 : 0

  zone_id = data.aws_route53_zone.worker[0].zone_id
  name    = trimspace(var.worker_dns_name)
  type    = "A"
  ttl     = 60
  records = [local.worker_public_ips[0]]

  allow_overwrite = true
}
