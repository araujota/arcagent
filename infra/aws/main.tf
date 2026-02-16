# ---------------------------------------------------------------------------
# ArcAgent Worker Infrastructure — Firecracker microVM hosts on AWS
# ---------------------------------------------------------------------------
#
# Deploys bare-metal EC2 instances with KVM support for running Firecracker
# microVMs. VPC uses 10.1.0.0/16 to avoid collision with Firecracker's
# internal 10.0.0.0/24 TAP subnet.
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Uncomment and configure for remote state:
  # backend "s3" {
  #   bucket         = "arcagent-terraform-state"
  #   key            = "worker/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "arcagent-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "arcagent"
      Component   = "worker"
      ManagedBy   = "terraform"
      Environment = var.environment
    }
  }
}

# Latest Ubuntu 22.04 LTS AMI
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}
