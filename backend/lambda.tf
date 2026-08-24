# --- Shared Lambda layer --------------------------------------------------------
# Contains the shared/db.mjs + shared/http.mjs helpers and every AWS SDK v3
# client package these functions need. Every function below attaches this
# layer instead of bundling its own node_modules.

data "archive_file" "layer" {
  type        = "zip"
  source_dir  = "${path.module}/lambda-layer"
  output_path = "${path.module}/.build/layer.zip"
}

resource "aws_lambda_layer_version" "shared" {
  layer_name          = "${var.name_prefix}-shared"
  filename            = data.archive_file.layer.output_path
  source_code_hash    = data.archive_file.layer.output_base64sha256
  compatible_runtimes = ["nodejs20.x"]
}

# --- Function definitions --------------------------------------------------------
# One entry per Lambda. `env` holds anything beyond the common set (DB
# connection info + frontend URL, both added to every function below).

locals {
  # timeout=28s across the board (not just the previous 10s default) —
  # every one of these touches Aurora via the Data API, and the retry loop
  # in shared/db.js for Aurora's auto-pause resume needs up to ~20s of
  # headroom on the first request after any idle period. Kept just under
  # API Gateway's hard 30-second integration timeout ceiling (fixed for
  # HTTP APIs, not configurable) so a slow-but-successful retry completes
  # cleanly rather than the gateway cutting the connection first.
  functions = {
    auth-signup               = { timeout = 28, memory = 256 }
    auth-resend-code          = { timeout = 28, memory = 256 }
    auth-confirm              = { timeout = 28, memory = 256 }
    auth-signin               = { timeout = 28, memory = 256 }
    auth-refresh              = { timeout = 28, memory = 256 }
    auth-forgot-password      = { timeout = 28, memory = 256 }
    auth-reset-password       = { timeout = 28, memory = 256 }
    auth-signout              = { timeout = 28, memory = 256 }
    users-profile             = { timeout = 28, memory = 256 }
    users-avatar-upload       = { timeout = 28, memory = 256 }
    users-follow              = { timeout = 28, memory = 256 }
    users-followers           = { timeout = 28, memory = 256 }
    diagrams-crud             = { timeout = 28, memory = 512 } # canvas_data payloads can be sizeable
    diagrams-list             = { timeout = 28, memory = 256 }
    diagrams-publish          = { timeout = 28, memory = 256 }
    diagrams-export           = { timeout = 28, memory = 256 }
    diagrams-thumbnail-upload = { timeout = 28, memory = 256 }
    feed                      = { timeout = 28, memory = 256 }
    discover                  = { timeout = 28, memory = 256 }
    search                    = { timeout = 28, memory = 256 }
    likes                     = { timeout = 28, memory = 256 }
    saves                     = { timeout = 28, memory = 256 }
    comments                  = { timeout = 28, memory = 256 }
    comments-item             = { timeout = 28, memory = 256 }
    comment-likes             = { timeout = 28, memory = 256 }
    notifications             = { timeout = 28, memory = 256 }
    follow-requests           = { timeout = 28, memory = 256 }
    user-services             = { timeout = 28, memory = 512 }
  }
}

data "archive_file" "function" {
  for_each    = local.functions
  type        = "zip"
  source_dir  = "${path.module}/lambda-src/${each.key}"
  output_path = "${path.module}/.build/${each.key}.zip"
}

resource "aws_cloudwatch_log_group" "function" {
  for_each          = local.functions
  name              = "/aws/lambda/${var.name_prefix}-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "function" {
  for_each      = local.functions
  function_name = "${var.name_prefix}-${each.key}"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = each.value.timeout
  memory_size   = each.value.memory

  filename         = data.archive_file.function[each.key].output_path
  source_code_hash = data.archive_file.function[each.key].output_base64sha256

  layers = [aws_lambda_layer_version.shared.arn]

  environment {
    variables = {
      DB_CLUSTER_ARN       = aws_rds_cluster.main.arn
      DB_SECRET_ARN        = aws_secretsmanager_secret.db_master.arn
      DB_NAME              = var.db_name
      USER_CONTENT_BUCKET  = aws_s3_bucket.user_content.bucket
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.web.id
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.main.id
      FRONTEND_URL         = var.frontend_url
    }
  }

  depends_on = [aws_cloudwatch_log_group.function]

  tags = {
    Project = "Cloud Architecture Platform"
  }
}
