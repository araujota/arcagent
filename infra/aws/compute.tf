# ---------------------------------------------------------------------------
# EC2 Worker Instances
# ---------------------------------------------------------------------------

resource "aws_instance" "worker" {
  count = var.worker_count

  depends_on = [aws_s3_object.bootstrap_scripts]

  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = var.ssh_key_name
  iam_instance_profile   = aws_iam_instance_profile.worker.name
  subnet_id              = aws_subnet.worker[count.index % length(aws_subnet.worker)].id
  vpc_security_group_ids = [aws_security_group.worker.id]

  root_block_device {
    volume_size           = var.root_volume_size_gb
    volume_type           = "gp3"
    iops                  = 6000
    throughput            = 400
    encrypted             = true
    delete_on_termination = true
  }

  # IP forwarding must be enabled for Firecracker TAP networking
  source_dest_check = false

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2 only
  }

  # WORKER_HOST_URL is auto-detected at boot via IMDSv2 (see setup-host.sh)
  # since the EIP isn't known at user_data render time.
  user_data = base64gzip(templatefile("${path.module}/scripts/setup-host.sh", {
    environment               = var.environment
    worker_shared_secret      = var.worker_shared_secret
    convex_url                = var.convex_url
    convex_http_actions_url   = var.convex_http_actions_url
    worker_role               = var.worker_role
    max_dev_vms               = var.max_dev_vms
    warm_pool_size            = var.warm_pool_size
    max_warm_vms              = var.max_warm_vms
    firecracker_version       = var.firecracker_version
    node_version              = var.node_version
    harden_egress             = var.harden_egress
    worker_concurrency        = var.worker_concurrency
    workspace_idle_timeout_ms = var.workspace_idle_timeout_ms
    rootfs_bucket             = aws_s3_bucket.rootfs.id
    rootfs_version            = var.rootfs_version
    rootfs_upload_on_boot     = var.rootfs_upload_on_boot
    aws_region                = var.aws_region
    route53_zone_name         = var.route53_zone_name
    worker_dns_name           = var.worker_dns_name
    worker_artifact_s3_key    = var.worker_artifact_s3_key
    worker_public_url         = var.worker_public_url
    enable_sonarqube          = var.enable_sonarqube
    sonarqube_url             = var.sonarqube_url
    sonarqube_token           = var.sonarqube_token
    snyk_token                = var.snyk_token
  }))

  tags = {
    Name = "arcagent-worker-${var.environment}-${count.index}"
  }

  lifecycle {
    # Prevent accidental destruction of running workers
    prevent_destroy = false # Set to true in production
    # Worker rollouts are handled via deploy artifact + service restart.
    # Avoid EC2 stop/start churn on every user_data template change.
    ignore_changes = [user_data]
  }
}

# Elastic IPs for stable addressing
resource "aws_eip" "worker" {
  count = var.allocate_eip ? var.worker_count : 0

  instance = aws_instance.worker[count.index].id
  domain   = "vpc"

  tags = {
    Name = "arcagent-worker-eip-${var.environment}-${count.index}"
  }
}
