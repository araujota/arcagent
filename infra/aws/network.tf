# ---------------------------------------------------------------------------
# VPC + Networking
# ---------------------------------------------------------------------------
#
# VPC uses 10.1.0.0/16 for worker hosts and future expansion room.
# ---------------------------------------------------------------------------

resource "aws_vpc" "worker" {
  cidr_block           = "10.1.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "arcagent-worker-${var.environment}"
  }
}

resource "aws_internet_gateway" "worker" {
  vpc_id = aws_vpc.worker.id

  tags = {
    Name = "arcagent-worker-igw-${var.environment}"
  }
}

locals {
  worker_az_count                    = min(length(data.aws_availability_zones.available.names), 2)
  enable_mcp_peering                 = trimspace(var.mcp_vpc_id) != "" && trimspace(var.mcp_vpc_cidr) != "" && length(var.mcp_private_route_table_ids) > 0
  effective_worker_api_allowed_cidrs = length(var.worker_api_allowed_cidrs) > 0 ? var.worker_api_allowed_cidrs : compact([trimspace(var.mcp_vpc_cidr), aws_vpc.worker.cidr_block])
  worker_to_mcp_route_table_ids      = var.create_nat_gateway ? [aws_route_table.worker.id] : [aws_route_table.worker.id, aws_route_table.public.id]
}

resource "aws_subnet" "public" {
  count = local.worker_az_count

  vpc_id                  = aws_vpc.worker.id
  cidr_block              = cidrsubnet("10.1.0.0/16", 8, count.index + 100)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "arcagent-worker-${var.environment}-public-${data.aws_availability_zones.available.names[count.index]}"
  }
}

resource "aws_subnet" "worker" {
  count = local.worker_az_count

  vpc_id                  = aws_vpc.worker.id
  cidr_block              = cidrsubnet("10.1.0.0/16", 8, count.index + 1)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = false

  tags = {
    Name = "arcagent-worker-${var.environment}-private-${data.aws_availability_zones.available.names[count.index]}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.worker.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.worker.id
  }

  lifecycle {
    ignore_changes = [route]
  }

  tags = {
    Name = "arcagent-worker-public-rt-${var.environment}"
  }
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count  = var.create_nat_gateway ? 1 : 0
  domain = "vpc"

  tags = {
    Name = "arcagent-worker-nat-eip-${var.environment}"
  }
}

resource "aws_nat_gateway" "worker" {
  count         = var.create_nat_gateway ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id

  tags = {
    Name = "arcagent-worker-nat-${var.environment}"
  }

  depends_on = [aws_internet_gateway.worker]
}

resource "aws_route_table" "worker" {
  vpc_id = aws_vpc.worker.id

  dynamic "route" {
    for_each = var.create_nat_gateway ? [1] : []
    content {
      cidr_block     = "0.0.0.0/0"
      nat_gateway_id = aws_nat_gateway.worker[0].id
    }
  }

  dynamic "route" {
    for_each = var.create_nat_gateway ? [] : [1]
    content {
      cidr_block = "0.0.0.0/0"
      gateway_id = aws_internet_gateway.worker.id
    }
  }

  lifecycle {
    ignore_changes = [route]
  }

  tags = {
    Name = "arcagent-worker-private-rt-${var.environment}"
  }
}

resource "aws_route_table_association" "worker" {
  count = length(aws_subnet.worker)

  subnet_id      = aws_subnet.worker[count.index].id
  route_table_id = aws_route_table.worker.id
}

resource "aws_vpc_peering_connection" "mcp" {
  count = local.enable_mcp_peering ? 1 : 0

  vpc_id      = aws_vpc.worker.id
  peer_vpc_id = var.mcp_vpc_id
  auto_accept = true

  tags = {
    Name = "arcagent-worker-to-mcp-${var.environment}"
  }
}

resource "aws_vpc_peering_connection_options" "mcp_requester" {
  count = local.enable_mcp_peering ? 1 : 0

  vpc_peering_connection_id = aws_vpc_peering_connection.mcp[0].id

  requester {
    allow_remote_vpc_dns_resolution = true
  }
}

resource "aws_vpc_peering_connection_options" "mcp_accepter" {
  count = local.enable_mcp_peering ? 1 : 0

  vpc_peering_connection_id = aws_vpc_peering_connection.mcp[0].id

  accepter {
    allow_remote_vpc_dns_resolution = true
  }
}

resource "aws_route" "worker_to_mcp" {
  for_each = local.enable_mcp_peering ? { for idx, routeTableId in local.worker_to_mcp_route_table_ids : tostring(idx) => routeTableId } : {}

  route_table_id            = each.value
  destination_cidr_block    = var.mcp_vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.mcp[0].id
}

resource "aws_route" "mcp_to_worker" {
  for_each = local.enable_mcp_peering ? toset(var.mcp_private_route_table_ids) : toset([])

  route_table_id            = each.value
  destination_cidr_block    = aws_vpc.worker.cidr_block
  vpc_peering_connection_id = aws_vpc_peering_connection.mcp[0].id
}

# ---------------------------------------------------------------------------
# Security Groups
# ---------------------------------------------------------------------------

resource "aws_security_group" "worker_alb" {
  name_prefix = "arcagent-worker-alb-${var.environment}-"
  description = "ArcAgent worker ALB ingress"
  vpc_id      = aws_vpc.worker.id

  ingress {
    description = "Worker API ingress"
    from_port   = 3001
    to_port     = 3001
    protocol    = "tcp"
    cidr_blocks = local.effective_worker_api_allowed_cidrs
  }

  egress {
    description = "Forward traffic to worker instances"
    from_port   = 3001
    to_port     = 3001
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.worker.cidr_block]
  }

  tags = {
    Name = "arcagent-worker-alb-sg-${var.environment}"
  }
}

resource "aws_security_group" "worker" {
  name_prefix = "arcagent-worker-${var.environment}-"
  description = "ArcAgent worker - only ALB ingress on 3001, optional SSH"
  vpc_id      = aws_vpc.worker.id

  # Worker API ingress is restricted to the internal ALB.
  ingress {
    description     = "Worker API from ALB only"
    from_port       = 3001
    to_port         = 3001
    protocol        = "tcp"
    security_groups = [aws_security_group.worker_alb.id]
  }

  # SSH access (optional, restricted to specified CIDRs)
  dynamic "ingress" {
    for_each = length(var.ssh_allowed_cidrs) > 0 ? [1] : []
    content {
      description = "SSH access"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.ssh_allowed_cidrs
    }
  }

  # All outbound (worker jobs need git clone, npm install, etc.)
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
    Name = "arcagent-worker-sg-${var.environment}"
  }
}
