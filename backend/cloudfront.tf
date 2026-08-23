# --- CloudFront for the frontend ------------------------------------------------
# Uses CloudFront's own default *.cloudfront.net domain and its automatically
# managed certificate — no ACM request needed for this. A custom domain (and
# the ACM cert that would require) is deferred until the product name is
# settled, per the agreed plan.

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.name_prefix}-frontend-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  default_root_object = "index.html"
  comment             = "${var.name_prefix} frontend"

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "frontend-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "frontend-s3"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  # SPA fallback. Now load-bearing: the app serves real paths (/@handle,
  # /d/{id}), and S3 has no object at those keys, so it answers 403/404.
  # Rewriting both to index.html with a 200 is what lets a shared profile link
  # survive a hard refresh instead of showing S3's error page.
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true # the free *.cloudfront.net cert — no ACM needed
  }

  tags = {
    Project = "Cloud Architecture Platform"
  }
}
