variable "aws_region" {
  description = "AWS region — must match the main project's region"
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Must match the main project's var.name_prefix exactly (it's \"cloudarch\", not \"cloudforger\" — resource names were kept generic during the portfolio phase, per variables.tf's own comment)"
  type        = string
  default     = "cloudarch"
}

variable "github_owner" {
  type    = string
  default = "stevenwaldron"
}

variable "github_repo" {
  type    = string
  default = "cloud-architecture-platform"
}

# Same immutable subject-claim situation as the chess project's bootstrap —
# this repo was created 2026-08-23, after the 2026-07-15 cutoff, so the
# classic repo:owner/repo:... format won't match tokens GitHub actually
# issues for it. Fetched via:
#   curl -s https://api.github.com/repos/<owner>/<repo> | grep -E '"id"|"login"' | head -4
variable "github_owner_id" {
  type    = string
  default = "57245025"
}

variable "github_repo_id" {
  type    = string
  default = "1343285508"
}
