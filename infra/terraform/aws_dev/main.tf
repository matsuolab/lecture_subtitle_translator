locals {
  prefix                       = "${var.project_name}-${var.environment}"
  use_batch_custom_ami         = trimspace(var.batch_custom_ami_id) != ""
  batch_worker_image_reference = trimspace(var.batch_worker_image_reference) != "" ? var.batch_worker_image_reference : "${aws_ecr_repository.worker.repository_url}:latest"
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# S3 バケット名は全AWSグローバルで一意である必要があるため、ランダムサフィックスを付与する。
# OSS として配布し不特定多数の組織がそれぞれのアカウントへ展開する想定なので、
# 利用者が名前を手当てしなくても衝突しないよう byte_length = 8（16桁hex / 2^64通り）で自動一意化する。
# 詳細: docs/research/20260616_terraform_oss_s3_naming.md
resource "random_id" "bucket" {
  byte_length = 8
}

resource "aws_s3_bucket" "input" {
  bucket = "${local.prefix}-input-${random_id.bucket.hex}"
  tags   = local.common_tags
}

resource "aws_s3_bucket_cors_configuration" "input" {
  bucket = aws_s3_bucket.input.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "GET", "HEAD"]
    # 注: tauri://localhost は S3/API Gateway が CORS オリジンとして受け付けない。
    # macOS/Linux の Tauri は tauriFetch(Rust側HTTP)で直接 PUT するため CORS 対象外。
    # 詳細: frontend/src/api/pipelineClient.ts / docs/aws_backend_setup_manual.md §3①
    allowed_origins = [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      "http://tauri.localhost",
      "https://tauri.localhost",
    ]
    expose_headers  = ["ETag"]
    max_age_seconds = 300
  }
}

resource "aws_s3_bucket" "result" {
  bucket = "${local.prefix}-result-${random_id.bucket.hex}"
  tags   = local.common_tags
}

resource "aws_dynamodb_table" "jobs" {
  name         = "${local.prefix}-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "job_id"

  attribute {
    name = "job_id"
    type = "S"
  }

  tags = local.common_tags
}

resource "aws_ecr_repository" "worker" {
  name = "${local.prefix}-worker"
  tags = local.common_tags
}

resource "aws_secretsmanager_secret" "bearer_token" {
  name = "${local.prefix}-bearer-token"
  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "bearer_token" {
  secret_id     = aws_secretsmanager_secret.bearer_token.id
  secret_string = var.managed_service_bearer_token
}

resource "aws_iam_role" "lambda_role" {
  name = "${local.prefix}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_managed_service" {
  name = "${local.prefix}-lambda-managed-service"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:GetObject"]
        Resource = [
          "${aws_s3_bucket.input.arn}/*",
          "${aws_s3_bucket.result.arn}/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [aws_s3_bucket.input.arn, aws_s3_bucket.result.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:DescribeTable", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.jobs.arn
      },
      {
        Effect   = "Allow"
        Action   = ["batch:DescribeJobDefinitions", "batch:DescribeJobQueues", "batch:SubmitJob"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.bearer_token.arn
      }
    ]
  })
}

resource "aws_iam_role" "batch_service_role" {
  name = "${local.prefix}-batch-service-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "batch.amazonaws.com"
      }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "batch_service_role" {
  role       = aws_iam_role.batch_service_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBatchServiceRole"
}

resource "aws_iam_role" "batch_execution_role" {
  name = "${local.prefix}-batch-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "batch_execution_role" {
  role       = aws_iam_role.batch_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "batch_job_role" {
  name = "${local.prefix}-batch-job-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "batch_job_role" {
  name = "${local.prefix}-batch-job-access"
  role = aws_iam_role.batch_job_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject"]
        Resource = [
          "${aws_s3_bucket.input.arn}/*",
          "${aws_s3_bucket.result.arn}/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.jobs.arn
      }
    ]
  })
}

resource "aws_launch_template" "batch_worker" {
  name_prefix = "${local.prefix}-batch-worker-"
  image_id    = local.use_batch_custom_ami ? var.batch_custom_ami_id : null

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      delete_on_termination = true
      volume_size           = var.batch_root_volume_size_gb
      volume_type           = "gp3"
    }
  }

  user_data = base64encode(<<-EOT
Content-Type: multipart/mixed; boundary="==BOUNDARY=="
MIME-Version: 1.0

--==BOUNDARY==
Content-Type: text/x-shellscript; charset="us-ascii"

#!/bin/bash
set -euxo pipefail
mkdir -p /etc/ecs
grep -q '^ECS_IMAGE_PULL_BEHAVIOR=' /etc/ecs/ecs.config 2>/dev/null || echo 'ECS_IMAGE_PULL_BEHAVIOR=${var.batch_image_pull_behavior}' >> /etc/ecs/ecs.config
if command -v dnf >/dev/null 2>&1; then
  dnf install -y amazon-ssm-agent || true
fi
systemctl enable --now amazon-ssm-agent || true
--==BOUNDARY==--
EOT
  )

  tag_specifications {
    resource_type = "instance"
    tags          = local.common_tags
  }

  tag_specifications {
    resource_type = "volume"
    tags          = local.common_tags
  }

  tags = local.common_tags
}
resource "aws_batch_compute_environment" "gpu" {
  compute_environment_name = "${local.prefix}-gpu"
  type                     = "MANAGED"
  service_role             = aws_iam_role.batch_service_role.arn
  state                    = "ENABLED"

  compute_resources {
    type                = "SPOT"
    allocation_strategy = "SPOT_CAPACITY_OPTIMIZED"
    max_vcpus           = var.batch_gpu_spot_max_vcpus
    min_vcpus           = 0
    desired_vcpus       = 0
    instance_type       = ["g4dn.xlarge"]
    subnets             = var.private_subnet_ids
    security_group_ids  = var.batch_security_group_ids
    instance_role       = aws_iam_instance_profile.batch_instance_profile.arn

    ec2_configuration {
      image_type = "ECS_AL2023_NVIDIA"
    }

    launch_template {
      launch_template_id = aws_launch_template.batch_worker.id
      version            = "$Latest"
    }
  }

  depends_on = [aws_iam_role_policy_attachment.batch_service_role]

  tags = local.common_tags
}

resource "aws_batch_compute_environment" "gpu_ondemand" {
  compute_environment_name = "${local.prefix}-gpu-ondemand"
  type                     = "MANAGED"
  service_role             = aws_iam_role.batch_service_role.arn
  state                    = "ENABLED"

  compute_resources {
    type                = "EC2"
    allocation_strategy = "BEST_FIT_PROGRESSIVE"
    max_vcpus           = var.batch_gpu_ondemand_max_vcpus
    min_vcpus           = 0
    desired_vcpus       = 0
    instance_type       = ["g4dn.xlarge"]
    subnets             = var.private_subnet_ids
    security_group_ids  = var.batch_security_group_ids
    instance_role       = aws_iam_instance_profile.batch_instance_profile.arn

    ec2_configuration {
      image_type = "ECS_AL2023_NVIDIA"
    }

    launch_template {
      launch_template_id = aws_launch_template.batch_worker.id
      version            = "$Latest"
    }
  }

  depends_on = [aws_iam_role_policy_attachment.batch_service_role]

  tags = local.common_tags
}
resource "aws_batch_compute_environment" "cpu_ondemand" {
  compute_environment_name_prefix = "${local.prefix}-cpu-ondemand-"
  type                            = "MANAGED"
  service_role                    = aws_iam_role.batch_service_role.arn
  state                           = "ENABLED"

  lifecycle {
    create_before_destroy = true
  }

  compute_resources {
    type                = "EC2"
    allocation_strategy = "BEST_FIT_PROGRESSIVE"
    max_vcpus           = var.batch_ondemand_max_vcpus
    min_vcpus           = 0
    desired_vcpus       = 0
    instance_type       = var.batch_instance_types
    subnets             = var.private_subnet_ids
    security_group_ids  = var.batch_security_group_ids
    instance_role       = aws_iam_instance_profile.batch_instance_profile.arn

    ec2_configuration {
      image_type = var.batch_ec2_image_type
    }

    launch_template {
      launch_template_id = aws_launch_template.batch_worker.id
      version            = "$Latest"
    }
  }

  depends_on = [aws_iam_role_policy_attachment.batch_service_role]

  tags = local.common_tags
}
resource "aws_iam_role" "batch_instance_role" {
  name = "${local.prefix}-batch-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "batch_instance_ecs" {
  role       = aws_iam_role.batch_instance_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_role_policy_attachment" "batch_instance_ssm" {
  role       = aws_iam_role.batch_instance_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_instance_profile" "batch_instance_profile" {
  name = "${local.prefix}-batch-instance-profile"
  role = aws_iam_role.batch_instance_role.name
}

resource "aws_batch_job_queue" "queue" {
  name     = "${local.prefix}-queue"
  state    = "ENABLED"
  priority = 1

  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.gpu_ondemand.arn
  }

  compute_environment_order {
    order               = 2
    compute_environment = aws_batch_compute_environment.gpu.arn
  }

  dynamic "compute_environment_order" {
    for_each = var.batch_include_cpu_fallback ? [1] : []
    content {
      order               = 3
      compute_environment = aws_batch_compute_environment.cpu_ondemand.arn
    }
  }

  tags = local.common_tags
}

resource "aws_batch_job_definition" "worker" {
  name = "${local.prefix}-worker"
  type = "container"

  platform_capabilities = ["EC2"]

  container_properties = jsonencode({
    image            = local.batch_worker_image_reference
    command          = ["python", "-m", "backend.aws_worker"]
    executionRoleArn = aws_iam_role.batch_execution_role.arn
    jobRoleArn       = aws_iam_role.batch_job_role.arn
    resourceRequirements = concat(
      [
        { type = "VCPU", value = tostring(var.batch_vcpus) },
        { type = "MEMORY", value = tostring(var.batch_memory) }
      ],
      var.batch_gpu_count > 0 ? [{ type = "GPU", value = tostring(var.batch_gpu_count) }] : []
    )
    environment = [
      { name = "AWS_REGION", value = var.aws_region },
      { name = "MANAGED_SERVICE_AWS_INPUT_BUCKET", value = aws_s3_bucket.input.bucket },
      { name = "WHISPERX_EXECUTION_BACKEND", value = "embedded" },
      { name = "WHISPERX_DEVICE", value = var.whisperx_device },
      { name = "WHISPERX_MODEL", value = var.whisperx_model },
      { name = "WHISPERX_LANGUAGE", value = var.whisperx_language },
      { name = "WHISPERX_COMPUTE_TYPE", value = var.whisperx_compute_type },
      { name = "WHISPERX_BATCH_SIZE", value = tostring(var.whisperx_batch_size) }
    ]
  })

  tags = local.common_tags
}

resource "aws_lambda_function" "managed_api" {
  function_name    = "${local.prefix}-managed-api"
  role             = aws_iam_role.lambda_role.arn
  runtime          = "python3.13"
  handler          = "backend.lambda_handler.handler"
  filename         = var.lambda_package_path
  timeout          = 30
  memory_size      = 512
  source_code_hash = filebase64sha256(var.lambda_package_path)

  dynamic "vpc_config" {
    for_each = length(var.lambda_subnet_ids) > 0 && length(var.lambda_security_group_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.lambda_subnet_ids
      security_group_ids = var.lambda_security_group_ids
    }
  }

  environment {
    variables = {
      MANAGED_SERVICE_BACKEND                  = "aws"
      MANAGED_SERVICE_AUTH_MODE                = "bearer_token"
      MANAGED_SERVICE_BEARER_TOKEN_SECRET_NAME = aws_secretsmanager_secret.bearer_token.name
      MANAGED_SERVICE_AWS_INPUT_BUCKET         = aws_s3_bucket.input.bucket
      MANAGED_SERVICE_AWS_RESULT_BUCKET        = aws_s3_bucket.result.bucket
      MANAGED_SERVICE_AWS_JOBS_TABLE           = aws_dynamodb_table.jobs.name
      MANAGED_SERVICE_AWS_BATCH_JOB_QUEUE      = aws_batch_job_queue.queue.name
      MANAGED_SERVICE_AWS_BATCH_JOB_DEFINITION = aws_batch_job_definition.worker.name
    }
  }

  tags = local.common_tags
}

resource "aws_apigatewayv2_api" "managed" {
  name          = "${local.prefix}-managed-api"
  protocol_type = "HTTP"
  tags          = local.common_tags
}

resource "aws_apigatewayv2_integration" "managed_lambda" {
  api_id                 = aws_apigatewayv2_api.managed.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.managed_api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.managed.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.managed_lambda.id}"
}

resource "aws_apigatewayv2_stage" "managed" {
  api_id      = aws_apigatewayv2_api.managed.id
  name        = "$default"
  auto_deploy = true
  tags        = local.common_tags
}

resource "aws_lambda_permission" "apigw_invoke" {
  statement_id  = "AllowHttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.managed_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.managed.execution_arn}/*/*"
}

# ── コスト管理 ────────────────────────────────────────────────

resource "aws_budgets_budget" "monthly" {
  name         = "${local.prefix}-monthly-budget"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # 実支出アラート: 予算額に対する 10 / 25 / 50 / 100%
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 10
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 25
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  # 予測アラート: 月末予測が予算を超える見込みで発火（急騰の早期警告）
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}

# ── コスト異常検知 (Cost Anomaly Detection) ──────────────────
# CE API エンドポイントは us-east-1 固定だが、グローバルサービスのため
# ap-northeast-1 プロバイダーのまま作成・管理できる。
# 名前は CLI で先行作成した実リソースに合わせ、project_name のみを接頭辞に使う。

resource "aws_ce_anomaly_monitor" "services" {
  name              = "${var.project_name}-services-monitor"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "cost" {
  name             = "${var.project_name}-anomaly-alerts"
  frequency        = "WEEKLY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]

  subscriber {
    type    = "EMAIL"
    address = var.budget_alert_email
  }

  # 異常の影響額が $5 以上で通知
  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = ["5"]
    }
  }
}

# ── S3 ライフサイクル ─────────────────────────────────────────

resource "aws_s3_bucket_lifecycle_configuration" "input" {
  bucket = aws_s3_bucket.input.id

  rule {
    id     = "expire-uploaded-files"
    status = "Enabled"

    filter {}

    expiration {
      days = var.s3_input_expiration_days
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "result" {
  bucket = aws_s3_bucket.result.id

  rule {
    id     = "tiering-and-expiration"
    status = "Enabled"

    filter {}

    transition {
      days          = var.s3_result_transition_days
      storage_class = "STANDARD_IA"
    }

    expiration {
      days = var.s3_result_expiration_days
    }
  }
}

# ── ECR ライフサイクル ────────────────────────────────────────

resource "aws_ecr_lifecycle_policy" "worker" {
  repository = aws_ecr_repository.worker.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "untagged images を1日後に削除"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "古いタグ付きイメージを ${var.ecr_keep_image_count} 件まで保持"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.ecr_keep_image_count
        }
        action = { type = "expire" }
      }
    ]
  })
}










