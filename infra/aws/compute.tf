# ---------------------------------------------------------------------------
# EC2 Bare Metal Instances (Firecracker requires KVM)
# ---------------------------------------------------------------------------

resource "aws_instance" "worker" {
  count = var.worker_count

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
  user_data = base64encode(templatefile("${path.module}/scripts/setup-host.sh", {
    environment               = var.environment
    worker_shared_secret      = var.worker_shared_secret
    convex_url                = var.convex_url
    max_dev_vms               = var.max_dev_vms
    warm_pool_size            = var.warm_pool_size
    max_warm_vms              = var.max_warm_vms
    firecracker_version       = var.firecracker_version
    node_version              = var.node_version
    harden_egress             = var.harden_egress
    worker_concurrency        = var.worker_concurrency
    workspace_idle_timeout_ms = var.workspace_idle_timeout_ms
  }))

  tags = {
    Name = "arcagent-worker-${var.environment}-${count.index}"
  }

  lifecycle {
    # Prevent accidental destruction of running workers
    prevent_destroy = false # Set to true in production
  }
}

# Elastic IPs for stable addressing
resource "aws_eip" "worker" {
  count = var.worker_count

  instance = aws_instance.worker[count.index].id
  domain   = "vpc"

  tags = {
    Name = "arcagent-worker-eip-${var.environment}-${count.index}"
  }
}
