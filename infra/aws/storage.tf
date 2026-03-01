# ---------------------------------------------------------------------------
# S3 Bucket for Worker Bootstrap Artifacts
# ---------------------------------------------------------------------------
# Stores provisioning scripts and optional worker build archives consumed
# by setup-host.sh during first boot.
# NOTE: resource name keeps "rootfs" for Terraform state compatibility.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "rootfs" {
  bucket        = "arcagent-rootfs-${data.aws_caller_identity.current.account_id}-${var.environment}"
  force_destroy = var.environment != "production" # Allow terraform destroy to empty non-production buckets

  tags = {
    Name = "arcagent-rootfs-${var.environment}"
  }
}

resource "aws_s3_bucket_versioning" "rootfs" {
  bucket = aws_s3_bucket.rootfs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "rootfs" {
  bucket = aws_s3_bucket.rootfs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "rootfs" {
  bucket = aws_s3_bucket.rootfs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

locals {
  bootstrap_scripts = {
    "setup-worker.sh"    = "${path.module}/scripts/setup-worker.sh"
    "detect-host-url.sh" = "${path.module}/scripts/detect-host-url.sh"
  }
}

resource "aws_s3_object" "bootstrap_scripts" {
  for_each = local.bootstrap_scripts

  bucket       = aws_s3_bucket.rootfs.id
  key          = "scripts/${each.key}"
  source       = each.value
  etag         = filemd5(each.value)
  content_type = "text/x-shellscript"
}
