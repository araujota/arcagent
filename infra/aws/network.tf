# ---------------------------------------------------------------------------
# VPC + Networking
# ---------------------------------------------------------------------------
#
# IMPORTANT: VPC uses 10.1.0.0/16 to avoid collision with Firecracker's
# internal 10.0.0.0/24 TAP subnet used for VM networking.
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

resource "aws_subnet" "worker" {
  count = min(length(data.aws_availability_zones.available.names), 2)

  vpc_id                  = aws_vpc.worker.id
  cidr_block              = cidrsubnet("10.1.0.0/16", 8, count.index + 1)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "arcagent-worker-${var.environment}-${data.aws_availability_zones.available.names[count.index]}"
  }
}

resource "aws_route_table" "worker" {
  vpc_id = aws_vpc.worker.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.worker.id
  }

  tags = {
    Name = "arcagent-worker-rt-${var.environment}"
  }
}

resource "aws_route_table_association" "worker" {
  count = length(aws_subnet.worker)

  subnet_id      = aws_subnet.worker[count.index].id
  route_table_id = aws_route_table.worker.id
}

# ---------------------------------------------------------------------------
# Security Groups
# ---------------------------------------------------------------------------

resource "aws_security_group" "worker" {
  name_prefix = "arcagent-worker-${var.environment}-"
  description = "ArcAgent worker — allows Convex/MCP inbound on 3001, optional SSH"
  vpc_id      = aws_vpc.worker.id

  # Worker API (port 3001) — Convex and MCP server communicate here
  ingress {
    description = "Worker API from anywhere (protected by WORKER_SHARED_SECRET)"
    from_port   = 3001
    to_port     = 3001
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
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

  # All outbound (VMs need git clone, npm install, etc.)
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
