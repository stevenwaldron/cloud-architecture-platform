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

  # Same note as the Route 53 module: local state for now. Point this at the
  # same S3 backend + DynamoDB lock table once you've set one up, so both
  # Terraform configs share one remote state location.
  #
  # backend "s3" {
  #   bucket         = "cloud-architecture-platform-terraform-state"
  #   key            = "backend/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "cloud-architecture-platform-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region
}
