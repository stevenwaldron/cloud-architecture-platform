# Cloud Architecture Platform — Backend (Pass 2)

Full backend infrastructure: Cognito, Aurora Serverless v2, API Gateway,
23 Lambda functions, two S3 buckets, and a CloudFront distribution for the
frontend on the default `*.cloudfront.net` domain.

**Deliberately out of scope for this pass** (per the agreed plan):
- The AI proxy Lambda — AI features are gated off entirely during the
  portfolio phase, and demo videos are recorded from the Claude.ai artifact
  preview instead, so no live AI backend is needed yet.
- Stripe billing (checkout/portal/webhook Lambdas).
- A custom domain, Route 53 records for it, and the ACM certificate that
  would require. The Route 53 *hosted zone* itself is a separate, already-
  applied Terraform pass — this module doesn't touch it.

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) (v1.5+)
- AWS CLI installed and configured (`aws configure`) — also required at
  apply time for the schema bootstrap step, not just for Terraform itself
- Node.js installed locally (used to `npm install` the Lambda layer's
  dependencies — already done in this package, but re-run if you change
  `lambda-layer/nodejs/package.json`)
- Your IAM user/role needs fairly broad permissions for this one: Cognito,
  RDS, Secrets Manager, S3, CloudFront, Lambda, API Gateway, IAM (to create
  the Lambda execution role), and CloudWatch Logs

## First-time setup

1. **Review `variables.tf`.** The one worth reading closely is `name_prefix`
   — defaults to `cloudarch`, deliberately generic rather than the real
   product name (see the comment in that file for why). Change it later by
   editing the variable and re-applying; every resource name derives from it.

2. **Social login is optional and off by default.** Every provider
   (Google, Facebook, Apple, Slack) only gets created if you supply its
   credentials. To enable any of them, create a `terraform.tfvars` file
   (already gitignored — never commit this) with whichever of these you
   have:
   ```hcl
   google_client_id       = "..."
   google_client_secret    = "..."
   facebook_client_id      = "..."
   facebook_client_secret  = "..."
   apple_client_id         = "..."
   apple_team_id           = "..."
   apple_key_id            = "..."
   apple_private_key       = "..."
   slack_client_id         = "..."
   slack_client_secret     = "..."
   ```
   Leave any provider's variables out entirely (or empty strings) and it's
   simply not created — email/password signup works regardless and needs no
   configuration.

   **GitHub is intentionally not included** — GitHub OAuth Apps don't expose
   a standards-compliant OIDC discovery document, so it can't be wired into
   Cognito's generic OIDC provider type the same clean way. Supporting it
   properly needs a custom OIDC bridge, which is more complexity than a
   portfolio deployment needs right now.

## Steps

```bash
terraform init
terraform validate   # do this first — this HCL hasn't been machine-validated
                      # in the environment it was written in, so this is the
                      # first real check
terraform plan
terraform apply
```

The `apply` will take a while — Aurora Serverless v2 cluster + instance
creation alone commonly takes 15-20+ minutes. Once it completes, Terraform
automatically runs `db/bootstrap.sh`, which applies `db/schema.sql` to the
new cluster via the RDS Data API. You shouldn't need to do anything for
this — it's wired in as a `null_resource` that depends on the cluster being
ready.

### After it's up

Terraform will print outputs including:
- `api_endpoint` — the base API URL
- `cloudfront_domain` — your live site URL (this is what you'll actually
  visit and eventually put on LinkedIn)
- `cognito_user_pool_id` / `cognito_client_id` — needed by the frontend's
  auth config
- `frontend_bucket_name` / `user_content_bucket_name`

A `next_steps` output also prints a short checklist. The most important one:
**once you have the CloudFront domain, update `var.frontend_url` to it and
re-apply** — this updates Cognito's callback URLs and the CORS configuration
to match the real deployed site instead of `localhost`.

## Deploying the actual frontend

This Terraform creates the *bucket* — it doesn't build or upload your React
app. After `npm run build` in the Cloud Architecture Platform frontend repo, sync the build
output to the frontend bucket:

```bash
aws s3 sync ./build s3://<frontend_bucket_name> --delete
aws cloudfront create-invalidation --distribution-id <distribution_id> --paths "/*"
```

(The distribution ID isn't currently in outputs.tf — add
`output "cloudfront_distribution_id" { value = aws_cloudfront_distribution.frontend.id }`
if you want it surfaced directly, or grab it from the AWS Console.)

## Architecture notes worth knowing

- **No NAT Gateway, no Internet Gateway.** Aurora needs a VPC with subnets
  in 2+ AZs, but Lambda reaches it through the RDS Data API — a regional
  AWS HTTPS endpoint — rather than a direct VPC connection. That means the
  DB subnets never need outbound internet access, which keeps this both
  simpler and avoids NAT Gateway's hourly cost, one of the few things in
  this stack that would otherwise cost real money.
- **One shared Lambda execution role**, not one per function — simpler to
  manage at this scale, and every policy statement on it is still scoped to
  exact resource ARNs, not wildcards.
- **One shared Lambda Layer** holds the RDS Data API / HTTP response
  helpers and all AWS SDK v3 clients these functions need, so no function
  bundles its own `node_modules`.
- **Soft deletes for diagrams** — deleting a diagram sets its status to
  `archived` rather than removing the row, preserving comment/like history
  and making it trivial to add a "restore" feature later without a schema
  change.

## What to do if `terraform apply` fails partway through

This is a lot of interdependent infrastructure being created in one pass,
and first-time applies to a fresh AWS account commonly hit one small,
fixable snag (a naming collision, an availability-zone quota issue, etc.).
`terraform apply` is safe to re-run after fixing whatever the error message
points to — Terraform picks up from what already exists rather than
starting over.
