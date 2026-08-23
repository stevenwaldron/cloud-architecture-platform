variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix used for all resource names. Kept generic during the portfolio phase (not the real product name) since resource names can surface in ARNs, error messages, and bucket policies. Change this and re-apply whenever you're ready to use the real name."
  type        = string
  default     = "cloudarch"
}

variable "environment" {
  description = "Environment tag applied to all resources"
  type        = string
  default     = "portfolio"
}

variable "db_name" {
  description = "Name of the initial database created in the Aurora cluster"
  type        = string
  default     = "cloudarch"
}

variable "db_master_username" {
  description = "Master username for the Aurora cluster"
  type        = string
  default     = "admin"
}

variable "aurora_min_capacity" {
  description = "Minimum Aurora Serverless v2 capacity units (ACUs). Set to 0 so the cluster fully auto-pauses (zero compute charges) when idle — appropriate for a portfolio deployment with sporadic traffic. Trade-off: the first request after a period of inactivity takes ~15 extra seconds while the cluster resumes. If that pause-and-resume latency becomes noticeable/annoying, raise this to 0.5 to keep it always warm — that costs roughly $43-45/month continuously in exchange for no cold-start delay."
  type        = number
  default     = 0
}

variable "aurora_max_capacity" {
  description = "Maximum Aurora Serverless v2 capacity units (ACUs). Kept low since this is a portfolio deployment, not production traffic."
  type        = number
  default     = 2
}

variable "log_retention_days" {
  description = "CloudWatch log retention for all Lambda log groups"
  type        = number
  default     = 30
}

variable "cognito_social_providers" {
  description = "Which social identity providers to enable on the Cognito User Pool. Each requires its own client ID/secret supplied via terraform.tfvars (not committed) — see README."
  type        = list(string)
  default     = ["Google", "GitHub", "Apple", "Facebook", "Slack"]
}

variable "frontend_url" {
  description = "The URL the frontend is served from — used for Cognito callback URLs and CORS."
  type        = string
  default     = "https://d14uhs480fdu02.cloudfront.net"
}
