terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "arcagent"
      Component   = "mcp"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "${var.name_prefix}-${var.environment}"

  azs = slice(data.aws_availability_zones.available.names, 0, min(2, length(data.aws_availability_zones.available.names)))

  use_existing_certificate = trimspace(var.acm_certificate_arn) != ""
  request_certificate      = !local.use_existing_certificate && var.request_acm_certificate

  certificate_arn = local.use_existing_certificate ? trimspace(var.acm_certificate_arn) : (
    local.request_certificate ? aws_acm_certificate.mcp[0].arn : ""
  )

  mcp_public_base_url      = "https://${var.mcp_public_domain}"
  worker_proxy_path_prefix = trim(var.worker_proxy_path_prefix, "/") != "" ? "/${trim(var.worker_proxy_path_prefix, "/")}" : "/worker-proxy"
  secret_arns = compact([
    var.worker_shared_secret_secret_arn,
    var.mcp_audit_log_token_secret_arn,
    var.register_captcha_secret_arn,
  ])

  task_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "MCP_TRANSPORT", value = "http" },
    { name = "MCP_PORT", value = tostring(var.container_port) },
    { name = "MCP_STARTUP_MODE", value = "full" },
    { name = "MCP_SESSION_MODE", value = var.session_mode },
    { name = "MCP_PUBLIC_BASE_URL", value = local.mcp_public_base_url },
    { name = "MCP_ALLOWED_HOSTS", value = var.mcp_public_domain },
    { name = "MCP_REQUIRE_HTTPS", value = "true" },
    { name = "MCP_JSON_BODY_LIMIT", value = var.mcp_json_body_limit },
    { name = "CONVEX_HTTP_ACTIONS_URL", value = var.convex_http_actions_url },
    { name = "RATE_LIMIT_STORE", value = "redis" },
    { name = "RATE_LIMIT_REDIS_URL", value = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379" },
    { name = "MCP_REGISTER_HONEYPOT_FIELD", value = var.register_honeypot_field },
    { name = "MCP_REGISTER_CAPTCHA_HEADER", value = var.register_captcha_header },
    { name = "MCP_ENABLE_CONVEX_AUDIT_LOGS", value = var.enable_convex_audit_logs ? "true" : "false" },
    { name = "MCP_INTERNAL_WORKER_BASE_URL", value = var.worker_internal_url },
    { name = "MCP_WORKER_PROXY_PATH_PREFIX", value = local.worker_proxy_path_prefix },
    { name = "WORKER_API_URL", value = "${local.mcp_public_base_url}${local.worker_proxy_path_prefix}" },
  ]

  task_secrets = concat(
    [
      { name = "WORKER_SHARED_SECRET", valueFrom = var.worker_shared_secret_secret_arn },
      { name = "MCP_AUDIT_LOG_TOKEN", valueFrom = var.mcp_audit_log_token_secret_arn },
    ],
    trimspace(var.register_captcha_secret_arn) != "" ? [
      { name = "MCP_REGISTER_CAPTCHA_SECRET", valueFrom = var.register_captcha_secret_arn },
    ] : []
  )
}

resource "aws_vpc" "mcp" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${local.name}-vpc"
  }
}

resource "aws_internet_gateway" "mcp" {
  vpc_id = aws_vpc.mcp.id

  tags = {
    Name = "${local.name}-igw"
  }
}

resource "aws_subnet" "public" {
  for_each = {
    for idx, cidr in var.public_subnet_cidrs : idx => cidr
  }

  vpc_id                  = aws_vpc.mcp.id
  cidr_block              = each.value
  availability_zone       = local.azs[tonumber(each.key) % length(local.azs)]
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name}-public-${each.key}"
  }
}

resource "aws_subnet" "private" {
  for_each = {
    for idx, cidr in var.private_subnet_cidrs : idx => cidr
  }

  vpc_id                  = aws_vpc.mcp.id
  cidr_block              = each.value
  availability_zone       = local.azs[tonumber(each.key) % length(local.azs)]
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.name}-private-${each.key}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.mcp.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.mcp.id
  }

  lifecycle {
    ignore_changes = [route]
  }

  tags = {
    Name = "${local.name}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count  = var.use_nat_gateway ? 1 : 0
  domain = "vpc"

  tags = {
    Name = "${local.name}-nat-eip"
  }
}

resource "aws_nat_gateway" "mcp" {
  count         = var.use_nat_gateway ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = values(aws_subnet.public)[0].id

  tags = {
    Name = "${local.name}-nat"
  }

  depends_on = [aws_internet_gateway.mcp]
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.mcp.id

  dynamic "route" {
    for_each = var.use_nat_gateway ? [1] : []
    content {
      cidr_block     = "0.0.0.0/0"
      nat_gateway_id = aws_nat_gateway.mcp[0].id
    }
  }

  lifecycle {
    ignore_changes = [route]
  }

  tags = {
    Name = "${local.name}-private-rt"
  }
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "alb" {
  name_prefix = "${local.name}-alb-"
  description = "ALB security group for hosted MCP"
  vpc_id      = aws_vpc.mcp.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_allowed_cidrs
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_allowed_cidrs
  }

  egress {
    from_port   = var.container_port
    to_port     = var.container_port
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = {
    Name = "${local.name}-alb-sg"
  }
}

resource "aws_security_group" "ecs" {
  name_prefix = "${local.name}-ecs-"
  description = "ECS task security group for hosted MCP"
  vpc_id      = aws_vpc.mcp.id

  ingress {
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  dynamic "egress" {
    for_each = trimspace(var.worker_vpc_cidr) != "" ? [var.worker_vpc_cidr] : []
    content {
      from_port   = 3001
      to_port     = 3001
      protocol    = "tcp"
      cidr_blocks = [egress.value]
    }
  }

  tags = {
    Name = "${local.name}-ecs-sg"
  }
}

resource "aws_security_group" "redis" {
  name_prefix = "${local.name}-redis-"
  description = "ElastiCache Redis security group for hosted MCP"
  vpc_id      = aws_vpc.mcp.id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = {
    Name = "${local.name}-redis-sg"
  }
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${replace(local.name, "_", "-")}-redis-subnets"
  subnet_ids = [for subnet in values(aws_subnet.private) : subnet.id]
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = replace(local.name, "_", "-")
  description                = "Redis for hosted Arcagent MCP rate limiting"
  engine                     = "redis"
  engine_version             = var.redis_engine_version
  node_type                  = var.redis_node_type
  num_cache_clusters         = var.redis_num_cache_clusters
  automatic_failover_enabled = var.redis_num_cache_clusters > 1
  multi_az_enabled           = var.redis_num_cache_clusters > 1
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.redis.id]
  port                       = 6379
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  apply_immediately          = true
}

resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/arcagent/mcp/${var.environment}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "mcp" {
  name = "${local.name}-cluster"
}

resource "aws_iam_role" "ecs_task_execution" {
  name = "${local.name}-ecs-task-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        },
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_default" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name = "${local.name}-ecs-task-exec-secrets"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "secretsmanager:GetSecretValue",
          "kms:Decrypt"
        ],
        Resource = local.secret_arns
      }
    ]
  })
}

resource "aws_iam_role" "ecs_task" {
  name = "${local.name}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        },
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_ecs_task_definition" "mcp" {
  family                   = "${local.name}-task"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "mcp-server"
      image     = var.container_image
      essential = true
      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]
      environment = local.task_env
      secrets     = local.task_secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.ecs.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"require('http').get('http://127.0.0.1:${var.container_port}/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }
    }
  ])
}

resource "aws_lb" "mcp" {
  name               = substr(replace(local.name, "_", "-"), 0, 32)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [for subnet in values(aws_subnet.public) : subnet.id]

  idle_timeout = 120

  tags = {
    Name = "${local.name}-alb"
  }
}

resource "aws_lb_target_group" "mcp" {
  name        = substr(replace("${local.name}-tg", "_", "-"), 0, 32)
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.mcp.id

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
    matcher             = "200"
  }

  stickiness {
    type            = "lb_cookie"
    enabled         = var.session_mode == "stateful"
    cookie_duration = 86400
  }
}

resource "aws_acm_certificate" "mcp" {
  count = local.request_certificate ? 1 : 0

  domain_name       = var.mcp_public_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.mcp.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.mcp.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.mcp.arn
  }

  lifecycle {
    precondition {
      condition     = trimspace(local.certificate_arn) != ""
      error_message = "Provide acm_certificate_arn or enable request_acm_certificate to configure HTTPS listener."
    }
  }
}

resource "aws_wafv2_web_acl_association" "mcp" {
  count = var.enable_waf ? 1 : 0

  resource_arn = aws_lb.mcp.arn
  web_acl_arn  = var.waf_web_acl_arn

  lifecycle {
    precondition {
      condition     = trimspace(var.waf_web_acl_arn) != ""
      error_message = "waf_web_acl_arn is required when enable_waf=true"
    }
  }
}

resource "aws_ecs_service" "mcp" {
  name            = "${local.name}-service"
  cluster         = aws_ecs_cluster.mcp.id
  task_definition = aws_ecs_task_definition.mcp.arn
  launch_type     = "FARGATE"
  desired_count   = var.desired_count

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = var.use_nat_gateway ? [for subnet in values(aws_subnet.private) : subnet.id] : [for subnet in values(aws_subnet.public) : subnet.id]
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = var.use_nat_gateway ? false : true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.mcp.arn
    container_name   = "mcp-server"
    container_port   = var.container_port
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_appautoscaling_target" "ecs" {
  count = var.enable_autoscaling ? 1 : 0

  max_capacity       = var.max_count
  min_capacity       = var.min_count
  resource_id        = "service/${aws_ecs_cluster.mcp.name}/${aws_ecs_service.mcp.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "ecs_cpu" {
  count = var.enable_autoscaling ? 1 : 0

  name               = "${local.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = var.cpu_target_utilization
    scale_in_cooldown  = var.autoscaling_scale_in_cooldown_seconds
    scale_out_cooldown = var.autoscaling_scale_out_cooldown_seconds
  }
}

resource "aws_appautoscaling_policy" "ecs_alb_requests" {
  count = var.enable_autoscaling ? 1 : 0

  name               = "${local.name}-alb-requests"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.mcp.arn_suffix}/${aws_lb_target_group.mcp.arn_suffix}"
    }
    target_value       = var.alb_requests_per_target
    scale_in_cooldown  = var.autoscaling_scale_in_cooldown_seconds
    scale_out_cooldown = var.autoscaling_scale_out_cooldown_seconds
  }
}
