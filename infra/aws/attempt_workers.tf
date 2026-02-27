# ---------------------------------------------------------------------------
# Dedicated Attempt Worker Resources (per-claim short-lived VMs)
# ---------------------------------------------------------------------------

locals {
  create_attempt_worker_template = var.enable_attempt_worker_template
}

resource "aws_security_group" "attempt_worker" {
  count = local.create_attempt_worker_template ? 1 : 0

  name_prefix = "arcagent-attempt-worker-${var.environment}-"
  description = "Dedicated attempt worker ingress"
  vpc_id      = aws_vpc.worker.id

  dynamic "ingress" {
    for_each = var.attempt_worker_open_https ? [1] : []
    content {
      description = "HTTPS"
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  dynamic "ingress" {
    for_each = var.attempt_worker_open_worker_port ? [1] : []
    content {
      description = "Worker API"
      from_port   = 3001
      to_port     = 3001
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "arcagent-attempt-worker-sg-${var.environment}"
  }
}

resource "aws_launch_template" "attempt_worker" {
  count = local.create_attempt_worker_template ? 1 : 0

  name_prefix            = "arcagent-attempt-worker-${var.environment}-"
  image_id               = var.attempt_worker_ami_id
  instance_type          = var.attempt_worker_instance_type
  vpc_security_group_ids = [aws_security_group.attempt_worker[0].id]

  iam_instance_profile {
    name = aws_iam_instance_profile.worker.name
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  monitoring {
    enabled = true
  }

  block_device_mappings {
    device_name = "/dev/sda1"

    ebs {
      volume_size           = var.attempt_worker_root_volume_size_gb
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"

    tags = {
      Name      = "arcagent-attempt-worker-${var.environment}"
      Component = "attempt-worker"
    }
  }

  lifecycle {
    create_before_destroy = true
    precondition {
      condition     = length(trimspace(var.attempt_worker_ami_id)) > 4
      error_message = "attempt_worker_ami_id must be set when enable_attempt_worker_template=true."
    }
  }
}
