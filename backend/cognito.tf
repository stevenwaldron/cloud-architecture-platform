# --- Cognito User Pool --------------------------------------------------------

resource "aws_cognito_user_pool" "main" {
  name = "${var.name_prefix}-users"

  username_attributes     = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
  }

  tags = {
    Project     = "Cloud Architecture Platform"
    Environment = var.environment
  }
}

# --- Social identity providers -------------------------------------------------
# Each is created ONLY if its credentials are supplied via terraform.tfvars
# (not committed — see README). This means the first `apply` succeeds with
# zero social providers configured and plain email/password signup working,
# so social login can be added incrementally without blocking the initial
# deploy. Supply credentials later and re-apply to turn any of these on.

variable "google_client_id" {
  type      = string
  default   = ""
  sensitive = true
}
variable "google_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

resource "aws_cognito_identity_provider" "google" {
  count         = var.google_client_id != "" ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = var.google_client_id
    client_secret     = var.google_client_secret
    authorize_scopes = "email openid profile"
  }

  attribute_mapping = {
    email    = "email"
    username = "sub"
  }
}

variable "facebook_client_id" {
  type      = string
  default   = ""
  sensitive = true
}
variable "facebook_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

resource "aws_cognito_identity_provider" "facebook" {
  count         = var.facebook_client_id != "" ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Facebook"
  provider_type = "Facebook"

  provider_details = {
    client_id        = var.facebook_client_id
    client_secret     = var.facebook_client_secret
    authorize_scopes = "email public_profile"
  }

  attribute_mapping = {
    email    = "email"
    username = "id"
  }
}

variable "apple_client_id" {
  description = "Apple 'Sign in with Apple' Services ID"
  type        = string
  default     = ""
  sensitive   = true
}
variable "apple_team_id" {
  type      = string
  default   = ""
  sensitive = true
}
variable "apple_key_id" {
  type      = string
  default   = ""
  sensitive = true
}
variable "apple_private_key" {
  type      = string
  default   = ""
  sensitive = true
}

resource "aws_cognito_identity_provider" "apple" {
  count         = var.apple_client_id != "" ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "SignInWithApple"
  provider_type = "SignInWithApple"

  provider_details = {
    client_id        = var.apple_client_id
    team_id          = var.apple_team_id
    key_id           = var.apple_key_id
    private_key      = var.apple_private_key
    authorize_scopes = "email name"
  }

  attribute_mapping = {
    email    = "email"
    username = "sub"
  }
}

variable "slack_client_id" {
  type      = string
  default   = ""
  sensitive = true
}
variable "slack_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

# Slack supports genuine OpenID Connect ("Sign in with Slack"), so it's wired
# as a generic OIDC provider rather than a Cognito-native one.
resource "aws_cognito_identity_provider" "slack" {
  count         = var.slack_client_id != "" ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Slack"
  provider_type = "OIDC"

  provider_details = {
    client_id                = var.slack_client_id
    client_secret            = var.slack_client_secret
    attributes_request_method = "GET"
    oidc_issuer              = "https://slack.com"
    authorize_scopes         = "openid email profile"
  }

  attribute_mapping = {
    email    = "email"
    username = "sub"
  }
}

# NOTE on GitHub: GitHub OAuth Apps don't expose a standards-compliant OIDC
# discovery document the way Cognito's generic OIDC provider type expects, so
# it can't be wired here the same clean way as Google/Facebook/Apple/Slack.
# Supporting it properly requires either a custom OIDC bridge (a small Lambda
# that fronts GitHub's OAuth flow and issues OIDC-shaped tokens) or a
# third-party identity broker. Deliberately left out of this first pass —
# worth revisiting post-launch if GitHub login turns out to matter to users,
# but not worth the added complexity for a portfolio deployment.

locals {
  enabled_identity_providers = concat(
    ["COGNITO"],
    length(aws_cognito_identity_provider.google) > 0 ? ["Google"] : [],
    length(aws_cognito_identity_provider.facebook) > 0 ? ["Facebook"] : [],
    length(aws_cognito_identity_provider.apple) > 0 ? ["SignInWithApple"] : [],
    length(aws_cognito_identity_provider.slack) > 0 ? ["Slack"] : [],
  )
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${var.name_prefix}-web-client"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret     = false # public client (browser SPA), no client secret
  explicit_auth_flows = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]

  supported_identity_providers = local.enabled_identity_providers

  callback_urls = [var.frontend_url, "http://localhost:3000"]
  logout_urls   = [var.frontend_url, "http://localhost:3000"]

  allowed_oauth_flows                 = ["code"]
  allowed_oauth_scopes                = ["email", "openid", "profile"]
  allowed_oauth_flows_user_pool_client = true

  access_token_validity  = 1   # hour
  id_token_validity      = 1   # hour
  refresh_token_validity = 30  # days

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  depends_on = [
    aws_cognito_identity_provider.google,
    aws_cognito_identity_provider.facebook,
    aws_cognito_identity_provider.apple,
    aws_cognito_identity_provider.slack,
  ]
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "${var.name_prefix}-auth-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.main.id
}

data "aws_caller_identity" "current" {}
