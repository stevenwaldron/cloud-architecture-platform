terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state. Local state can't be shared with CI runners and is a single
  # point of failure — losing the laptop means losing the only record of what
  # is deployed. use_lockfile takes locking from S3 itself (Terraform 1.10+),
  # so no DynamoDB table is needed.
  backend "s3" {
    bucket       = "cloud-arch-platform-tfstate-099814429392"
    key          = "backend/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region
}
