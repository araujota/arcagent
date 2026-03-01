# ---------------------------------------------------------------------------
# Optional DNS record for stable worker endpoint
# ---------------------------------------------------------------------------

locals {
  create_worker_dns_record = trimspace(var.route53_zone_name) != "" && trimspace(var.worker_dns_name) != "" && (
    var.enable_autoscaling ? var.asg_desired_capacity > 0 : var.worker_count > 0
  )
}

data "aws_route53_zone" "worker" {
  count        = local.create_worker_dns_record ? 1 : 0
  name         = "${trimspace(var.route53_zone_name)}."
  private_zone = false
}

resource "aws_route53_record" "worker_asg_alias" {
  count = local.create_worker_dns_record && var.enable_autoscaling ? 1 : 0

  zone_id = data.aws_route53_zone.worker[0].zone_id
  name    = trimspace(var.worker_dns_name)
  type    = "A"

  alias {
    name                   = aws_lb.worker[0].dns_name
    zone_id                = aws_lb.worker[0].zone_id
    evaluate_target_health = true
  }

  allow_overwrite = true
}

resource "aws_route53_record" "worker_single_instance" {
  count = local.create_worker_dns_record && !var.enable_autoscaling ? 1 : 0

  zone_id = data.aws_route53_zone.worker[0].zone_id
  name    = trimspace(var.worker_dns_name)
  type    = "A"
  ttl     = 60
  records = [local.worker_public_ips[0]]

  allow_overwrite = true
}
