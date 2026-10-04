terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Local state deliberately — this config creates the S3 bucket the main
  # project's backend will use. Can't point at a remote backend that doesn't
  # exist yet. Only ever changes if the bootstrap resources themselves
  # change (rare), so local + out of version control is fine.
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}
