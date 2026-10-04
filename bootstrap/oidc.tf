resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

# Trust policy is the actual security boundary — only a token whose subject
# matches this exact repo, on exactly main, can assume this role.
resource "aws_iam_role" "github_actions" {
  name = "github-actions-deploy" # matches the role name already hardcoded in deploy.yml

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          # Two valid shapes for this one role: jobs with no "environment:"
          # (validate, plan) get a ref-based subject; the deploy job, which
          # sets environment: production, gets an environment-based subject
          # instead — GitHub's default behavior once a job references an
          # environment. Both have to be allowed since all three jobs share
          # this one role.
          "token.actions.githubusercontent.com:sub" = [
            "repo:${var.github_owner}@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}:ref:refs/heads/main",
            "repo:${var.github_owner}@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}:environment:production",
          ]
        }
      }
    }]
  })
}

# Scoped by resource-name prefix everywhere IAM actually supports it, built
# directly from reading every backend/*.tf file rather than guessed — three
# service families (API Gateway v2, CloudFront, EC2) get Resource: "*"
# because their control-plane / Describe* actions don't support
# resource-level restriction at all; that's a real AWS limitation for each,
# not a shortcut taken here.
resource "aws_iam_role_policy" "github_actions_deploy" {
  name = "${var.name_prefix}-deploy-permissions"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "TerraformStateAccess"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.tfstate.arn, "${aws_s3_bucket.tfstate.arn}/*"]
      },
      {
        Sid    = "ApplicationBuckets"
        Effect = "Allow"
        Action = ["s3:*"]
        Resource = [
          "arn:aws:s3:::${var.name_prefix}-frontend-*",
          "arn:aws:s3:::${var.name_prefix}-frontend-*/*",
          "arn:aws:s3:::${var.name_prefix}-user-content-*",
          "arn:aws:s3:::${var.name_prefix}-user-content-*/*",
        ]
      },
      {
        Sid    = "AuroraCluster"
        Effect = "Allow"
        Action = ["rds:*"]
        Resource = [
          "arn:aws:rds:${var.aws_region}:${data.aws_caller_identity.current.account_id}:cluster:${var.name_prefix}-*",
          "arn:aws:rds:${var.aws_region}:${data.aws_caller_identity.current.account_id}:subgrp:${var.name_prefix}-*",
          # The cluster instance's identifier is auto-generated ("tf-<timestamp>"), so it can never match a cloudarch-* pattern.
          "arn:aws:rds:${var.aws_region}:${data.aws_caller_identity.current.account_id}:db:tf-*",
        ]
      },
      {
        # rds:DescribeDBEngineVersions (used by the data "aws_rds_engine_version"
        # lookup in aurora.tf) and rds:DescribeDBClusters/-Instances don't
        # support resource-level restriction — read-only, low risk either way.
        Sid      = "AuroraDescribe"
        Effect   = "Allow"
        Action   = ["rds:Describe*"]
        Resource = "*"
      },
      {
        # Needed by the deploy role itself, not just the Lambda runtime role —
        # db_bootstrap.tf's local-exec provisioner runs `aws rds-data
        # execute-statement` directly during terraform apply, under whatever
        # credentials the CI job is using.
        Sid    = "RdsDataApiForSchemaBootstrap"
        Effect = "Allow"
        Action = [
          "rds-data:ExecuteStatement",
          "rds-data:BatchExecuteStatement",
        ]
        Resource = "arn:aws:rds:${var.aws_region}:${data.aws_caller_identity.current.account_id}:cluster:${var.name_prefix}-*"
      },
      {
        Sid      = "SecretsManager"
        Effect   = "Allow"
        Action   = ["secretsmanager:*"]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.name_prefix}/*"
      },
      {
        # EC2's Describe* actions (constantly needed while managing the VPC,
        # subnets, security group) require Resource: "*" — a real EC2 API
        # limitation, not a shortcut.
        Sid      = "VpcNetworking"
        Effect   = "Allow"
        Action   = ["ec2:*"]
        Resource = "*"
      },
      {
        Sid      = "CognitoUserPool"
        Effect   = "Allow"
        Action   = ["cognito-idp:*"]
        Resource = "*" # CreateUserPool can't be scoped to an ARN that doesn't exist yet
      },
      {
        Sid    = "LambdaFunctionsAndLayer"
        Effect = "Allow"
        Action = ["lambda:*"]
        Resource = [
          "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${var.name_prefix}-*",
          "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:layer:${var.name_prefix}-*",
          "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:layer:${var.name_prefix}-*:*",
        ]
      },
      {
        Sid      = "ManageOwnLambdaExecRole"
        Effect   = "Allow"
        Action   = ["iam:GetRole", "iam:CreateRole", "iam:DeleteRole", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:TagRole", "iam:UntagRole", "iam:ListRoleTags", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy", "iam:PassRole"]
        Resource = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-*"
      },
      {
        Sid      = "ApiGatewayManagement"
        Effect   = "Allow"
        Action   = ["apigateway:*"]
        Resource = "*" # control-plane actions require this — see file header
      },
      {
        Sid      = "CloudFrontManagement"
        Effect   = "Allow"
        Action   = ["cloudfront:*"]
        Resource = "*" # same story as API Gateway
      },
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = ["logs:*"]
        Resource = [
          "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.name_prefix}-*",
          "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.name_prefix}-*:*",
          "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/apigateway/${var.name_prefix}*",
          "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/apigateway/${var.name_prefix}*:*",
        ]
      },
      {
        # DescribeLogGroups is a list-style call; IAM can't restrict it to individual log-group ARNs.
        Sid      = "LogGroupDescribe"
        Effect   = "Allow"
        Action   = ["logs:DescribeLogGroups", "logs:ListTagsForResource", "logs:ListTagsLogGroup"]
        Resource = "*"
      },
      {
        Sid      = "CallerIdentity"
        Effect   = "Allow"
        Action   = "sts:GetCallerIdentity"
        Resource = "*"
      }
    ]
  })
}
