# --- API Gateway (HTTP API) -----------------------------------------------------

resource "aws_apigatewayv2_api" "main" {
  name          = "${var.name_prefix}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = [var.frontend_url, "http://localhost:3000"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["Content-Type", "Authorization"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_stage" "main" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      integrationErr = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/aws/apigateway/${var.name_prefix}"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.main.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${var.name_prefix}-cognito-authorizer"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.web.id]
    issuer   = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
  }
}

# One integration per Lambda function.
resource "aws_apigatewayv2_integration" "function" {
  for_each               = local.functions
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.function[each.key].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_lambda_permission" "apigw" {
  for_each      = local.functions
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.function[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# --- Routes -----------------------------------------------------------------------
# `auth = false` routes have no JWT authorizer attached (public/unauthenticated).
# Everything else requires a valid Cognito access token.

locals {
  routes = {
    "POST /auth/signup"                    = { fn = "auth-signup", auth = false }
    "POST /auth/resend-code"               = { fn = "auth-resend-code", auth = false }
    "POST /auth/confirm"                   = { fn = "auth-confirm", auth = false }
    "POST /auth/signin"                    = { fn = "auth-signin", auth = false }
    "POST /auth/refresh"                   = { fn = "auth-refresh", auth = false }
    "POST /auth/forgot-password"           = { fn = "auth-forgot-password", auth = false }
    "POST /auth/reset-password"            = { fn = "auth-reset-password", auth = false }
    "POST /auth/signout"                   = { fn = "auth-signout", auth = false } # token itself is the auth; see auth-signout/index.mjs

    "GET /users/lookup"                    = { fn = "users-profile", auth = false }
    "GET /users/handle-available"           = { fn = "users-profile", auth = false }
    "GET /users/me"                        = { fn = "users-profile", auth = true }  # own record + settings; must stay above the {userId} route conceptually — API Gateway prefers the literal path
    "GET /users/{userId}"                  = { fn = "users-profile", auth = false }
    "PUT /users/me"                        = { fn = "users-profile", auth = true }
    "POST /users/me/avatar"                = { fn = "users-avatar-upload", auth = true }
    "POST /users/{userId}/follow"          = { fn = "users-follow", auth = true }
    "DELETE /users/{userId}/follow"        = { fn = "users-follow", auth = true }
    "GET /users/{userId}/followers"        = { fn = "users-followers", auth = false }
    "GET /users/{userId}/diagrams"         = { fn = "diagrams-list", auth = false }
    "GET /users/{userId}/services"         = { fn = "user-services", auth = false }

    "POST /diagrams"                       = { fn = "diagrams-crud", auth = true }
    "GET /diagrams/{diagramId}"            = { fn = "diagrams-crud", auth = false }
    "PUT /diagrams/{diagramId}"            = { fn = "diagrams-crud", auth = true }
    "DELETE /diagrams/{diagramId}"         = { fn = "diagrams-crud", auth = true }
    "POST /diagrams/{diagramId}/publish"   = { fn = "diagrams-publish", auth = true }
    "POST /diagrams/{diagramId}/export"    = { fn = "diagrams-export", auth = true }
    "GET /diagrams/{diagramId}/export"     = { fn = "diagrams-export", auth = true }
    "POST /diagrams/{diagramId}/thumbnail" = { fn = "diagrams-thumbnail-upload", auth = true }

    "GET /feed"                            = { fn = "feed", auth = true }
    "GET /discover"                        = { fn = "discover", auth = false }
    "GET /search"                          = { fn = "search", auth = false }

    "GET /diagrams/{diagramId}/likes"      = { fn = "likes", auth = false }
    "POST /diagrams/{diagramId}/likes"     = { fn = "likes", auth = true }
    "DELETE /diagrams/{diagramId}/likes"   = { fn = "likes", auth = true }

    "GET /saves"                           = { fn = "saves", auth = true }
    "POST /diagrams/{diagramId}/saves"     = { fn = "saves", auth = true }
    "DELETE /diagrams/{diagramId}/saves"   = { fn = "saves", auth = true }

    "GET /diagrams/{diagramId}/comments"   = { fn = "comments", auth = false }
    "POST /diagrams/{diagramId}/comments"  = { fn = "comments", auth = true }
    "PUT /comments/{commentId}"            = { fn = "comments-item", auth = true }
    "DELETE /comments/{commentId}"         = { fn = "comments-item", auth = true }
    "POST /comments/{commentId}/likes"     = { fn = "comment-likes", auth = true }
    "DELETE /comments/{commentId}/likes"   = { fn = "comment-likes", auth = true }

    "GET /follow-requests"                      = { fn = "follow-requests", auth = true }
    "PUT /follow-requests/{requesterId}"        = { fn = "follow-requests", auth = true }
    "DELETE /follow-requests/{requesterId}"     = { fn = "follow-requests", auth = true }

    "GET /notifications"                        = { fn = "notifications", auth = true }
    "PUT /notifications/read-all"               = { fn = "notifications", auth = true }
    "PUT /notifications/{notificationId}"       = { fn = "notifications", auth = true }
    "DELETE /notifications/{notificationId}"    = { fn = "notifications", auth = true }
  }
}

resource "aws_apigatewayv2_route" "route" {
  for_each  = local.routes
  api_id    = aws_apigatewayv2_api.main.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.function[each.value.fn].id}"

  authorization_type = each.value.auth ? "JWT" : "NONE"
  authorizer_id       = each.value.auth ? aws_apigatewayv2_authorizer.cognito.id : null
}
