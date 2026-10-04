output "tfstate_bucket_name" {
  description = "Put this in backend/main.tf's backend \"s3\" block (bucket = ...)"
  value       = aws_s3_bucket.tfstate.id
}

output "github_actions_role_arn" {
  description = "Should match arn:aws:iam::<new-account-id>:role/github-actions-deploy — already hardcoded in deploy.yml, just needs the account ID to change"
  value       = aws_iam_role.github_actions.arn
}
