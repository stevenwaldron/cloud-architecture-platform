output "api_endpoint" {
  description = "Base URL for the API — this goes into the frontend's API base URL config"
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "cloudfront_domain" {
  description = "The live site URL — the default *.cloudfront.net domain, no custom domain needed"
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "cloudfront_distribution_id" {
  description = "Needed for `aws cloudfront create-invalidation` after deploying new frontend files"
  value       = aws_cloudfront_distribution.frontend.id
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "cognito_domain" {
  description = "Cognito Hosted UI domain, useful if you ever want to use Cognito's built-in login page instead of a fully custom one"
  value       = aws_cognito_user_pool_domain.main.domain
}

output "frontend_bucket_name" {
  value = aws_s3_bucket.frontend.bucket
}

output "user_content_bucket_name" {
  value = aws_s3_bucket.user_content.bucket
}

output "aurora_cluster_arn" {
  value = aws_rds_cluster.main.arn
}

output "aurora_secret_arn" {
  description = "Secrets Manager ARN holding the Aurora master credentials"
  value       = aws_secretsmanager_secret.db_master.arn
}

output "enabled_social_providers" {
  description = "Which social login providers are actually active (based on which credentials were supplied)"
  value       = local.enabled_identity_providers
}

output "next_steps" {
  value = <<-EOT
    1. Deploy the built frontend to the '${aws_s3_bucket.frontend.bucket}' bucket.
    2. Update the frontend's API base URL to: ${aws_apigatewayv2_api.main.api_endpoint}
    3. Update var.frontend_url to the CloudFront domain above and re-apply,
       so Cognito callback URLs and CORS match the real deployed site.
    4. Visit https://${aws_cloudfront_distribution.frontend.domain_name} once the frontend is deployed.
  EOT
}
