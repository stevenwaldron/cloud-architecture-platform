# --- Remote state bucket ---
# Versioned (recovery from a bad apply), encrypted at rest, no public access.
#
# No DynamoDB lock table here, unlike the chess project's bootstrap — this
# project's backend "s3" block already sets use_lockfile = true, Terraform
# 1.10+'s native S3-based locking. A separate lock table would just be an
# unused resource.

resource "aws_s3_bucket" "tfstate" {
  bucket = "${var.name_prefix}-tfstate-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
