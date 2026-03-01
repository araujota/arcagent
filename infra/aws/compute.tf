# ---------------------------------------------------------------------------
# EC2 Worker Instances / Auto Scaling Group
# ---------------------------------------------------------------------------

locals {
  worker_public_url_effective = trimspace(var.worker_public_url) != "" ? trimspace(var.worker_public_url) : (
    var.enable_autoscaling ? "http://${aws_lb.worker[0].dns_name}:3001" : ""
  )

  worker_user_data = base64gzip(templatefile("${path.module}/scripts/setup-host.sh", {
    environment               = var.environment
    worker_shared_secret      = var.worker_shared_secret
    convex_url                = var.convex_url
    convex_http_actions_url   = var.convex_http_actions_url
    worker_role               = var.worker_role
    max_dev_vms               = var.max_dev_vms
    warm_pool_size            = var.warm_pool_size
    max_warm_vms              = var.max_warm_vms
    node_version              = var.node_version
    worker_concurrency        = var.worker_concurrency
    workspace_idle_timeout_ms = var.workspace_idle_timeout_ms
    artifact_bucket           = aws_s3_bucket.rootfs.id
    aws_region                = var.aws_region
    route53_zone_name         = var.route53_zone_name
    worker_dns_name           = var.worker_dns_name
    worker_artifact_s3_key    = var.worker_artifact_s3_key
    worker_public_url         = local.worker_public_url_effective
    enable_sonarqube          = var.enable_sonarqube
    sonarqube_url             = var.sonarqube_url
    sonarqube_token           = var.sonarqube_token
    snyk_token                = var.snyk_token
  }))
}

resource "aws_instance" "worker" {
  count = var.enable_autoscaling ? 0 : var.worker_count

  depends_on = [aws_s3_object.bootstrap_scripts]

  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = var.ssh_key_name
  iam_instance_profile   = aws_iam_instance_profile.worker.name
  subnet_id              = aws_subnet.worker[count.index % length(aws_subnet.worker)].id
  vpc_security_group_ids = [aws_security_group.worker.id]
  user_data              = local.worker_user_data

  root_block_device {
    volume_size           = var.root_volume_size_gb
    volume_type           = "gp3"
    iops                  = 6000
    throughput            = 400
    encrypted             = true
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  tags = {
    Name = "arcagent-worker-${var.environment}-${count.index}"
  }

  lifecycle {
    prevent_destroy = false
    ignore_changes  = [user_data]
  }
}

resource "aws_launch_template" "worker" {
  count = var.enable_autoscaling ? 1 : 0

  name_prefix   = "arcagent-worker-${var.environment}-"
  image_id      = data.aws_ami.ubuntu.id
  instance_type = var.instance_type
  key_name      = var.ssh_key_name
  user_data     = local.worker_user_data

  iam_instance_profile {
    name = aws_iam_instance_profile.worker.name
  }

  vpc_security_group_ids = [aws_security_group.worker.id]

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
      volume_size           = var.root_volume_size_gb
      volume_type           = "gp3"
      iops                  = 6000
      throughput            = 400
      encrypted             = true
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"

    tags = {
      Name = "arcagent-worker-${var.environment}"
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_group" "worker" {
  count = var.enable_autoscaling ? 1 : 0

  name                = "arcagent-worker-${var.environment}"
  desired_capacity    = var.asg_desired_capacity
  min_size            = var.asg_min_size
  max_size            = var.asg_max_size
  vpc_zone_identifier = aws_subnet.worker[*].id
  target_group_arns   = [aws_lb_target_group.worker[0].arn]

  launch_template {
    id      = aws_launch_template.worker[0].id
    version = "$Latest"
  }

  health_check_type         = "EC2"
  health_check_grace_period = 300
  default_cooldown          = var.asg_scale_out_cooldown_seconds
  default_instance_warmup   = var.asg_scale_in_cooldown_seconds

  tag {
    key                 = "Name"
    value               = "arcagent-worker-${var.environment}"
    propagate_at_launch = true
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_s3_object.bootstrap_scripts]
}

resource "aws_autoscaling_policy" "worker_cpu" {
  count = var.enable_autoscaling ? 1 : 0

  name                   = "arcagent-worker-cpu-target-${var.environment}"
  autoscaling_group_name = aws_autoscaling_group.worker[0].name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
    target_value     = var.asg_cpu_target_utilization
    disable_scale_in = false
  }
}

resource "aws_lb" "worker" {
  count = var.enable_autoscaling ? 1 : 0

  name               = "arcagent-worker-${var.environment}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.worker.id]
  subnets            = aws_subnet.worker[*].id
}

resource "aws_lb_target_group" "worker" {
  count = var.enable_autoscaling ? 1 : 0

  name        = "arcagent-worker-${var.environment}"
  port        = 3001
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = aws_vpc.worker.id

  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200"
    path                = "/api/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    timeout             = 5
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "worker_http" {
  count = var.enable_autoscaling ? 1 : 0

  load_balancer_arn = aws_lb.worker[0].arn
  port              = 3001
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.worker[0].arn
  }
}

# Elastic IPs for stable addressing (non-autoscaling mode only)
resource "aws_eip" "worker" {
  count = (!var.enable_autoscaling && var.allocate_eip) ? var.worker_count : 0

  instance = aws_instance.worker[count.index].id
  domain   = "vpc"

  tags = {
    Name = "arcagent-worker-eip-${var.environment}-${count.index}"
  }
}
