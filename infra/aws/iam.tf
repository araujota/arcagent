# ---------------------------------------------------------------------------
# IAM Role for Worker EC2 Instances
# ---------------------------------------------------------------------------

resource "aws_iam_role" "worker" {
  name = "arcagent-worker-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })
}

# CloudWatch Logs for worker service logs
resource "aws_iam_role_policy" "worker_cloudwatch" {
  name = "arcagent-worker-cloudwatch-${var.environment}"
  role = aws_iam_role.worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Resource = "arn:aws:logs:*:*:log-group:/arcagent/worker/*"
      }
    ]
  })
}

# SSM for parameter access and Session Manager (optional SSH alternative)
resource "aws_iam_role_policy_attachment" "worker_ssm" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# ECR read access for pulling rootfs images (if stored in ECR)
resource "aws_iam_role_policy" "worker_ecr" {
  name = "arcagent-worker-ecr-${var.environment}"
  role = aws_iam_role.worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:GetAuthorizationToken"
        ]
        Resource = "*"
      }
    ]
  })
}

# S3 read access for downloading pre-built rootfs images
resource "aws_iam_role_policy" "worker_s3_rootfs" {
  name = "arcagent-worker-s3-rootfs-${var.environment}"
  role = aws_iam_role.worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.rootfs.arn,
          "${aws_s3_bucket.rootfs.arn}/*"
        ]
      }
    ]
  })
}

# Route53 updates so worker can keep stable DNS mapped to current public IP
# when EIP allocation is unavailable.
resource "aws_iam_role_policy" "worker_route53_dns" {
  name = "arcagent-worker-route53-${var.environment}"
  role = aws_iam_role.worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "route53:ListHostedZonesByName",
          "route53:ListResourceRecordSets",
          "route53:ChangeResourceRecordSets"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "worker" {
  name = "arcagent-worker-${var.environment}"
  role = aws_iam_role.worker.name
}
