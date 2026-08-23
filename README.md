# Cloud Architecture Platform

A full-stack SaaS platform for designing, publishing and discussing cloud architecture diagrams — built and deployed solo, from an empty repository to a running multi-tenant application on AWS.

**Live:** https://d14uhs480fdu02.cloudfront.net

---

## What it does

- **Designer** — drag AWS services onto a canvas, connect them, group them into VPCs, subnets, NACLs and security groups, annotate with labels and callouts, and animate data flow along connections.
- **Publishing** — publish a diagram to a feed with a preview step for description, tags and a structured case study.
- **Social layer** — follow other engineers, like, save, comment, and reply with threaded conversations and notifications.
- **Portfolio profiles** — public, no-login profiles with a services breakdown derived from your actual diagrams, pinned work, and case studies. Shareable with someone who has no account.
- **Privacy** — accounts can be made private, at which point following becomes request-based with approve/deny.

---

## Architecture

A static React bundle on CloudFront calls a serverless API. There is no server to patch and nothing running when the platform is idle.

```
Browser  ->  CloudFront (S3 origin, Origin Access Control)  ->  React SPA
Browser  ->  API Gateway HTTP API  ->  JWT authorizer (Cognito)  ->  Lambda
Lambda   ->  RDS Data API  ->  Aurora MySQL (private subnets)
Lambda   ->  S3 (thumbnails, avatars)  ->  served back via CloudFront
```

**Deployed today:** 26 Lambda functions · Aurora Serverless v2 · Cognito user pool · API Gateway HTTP API with JWT authorizer · S3 + CloudFront with OAC · all Terraform-managed.

---

## Engineering decisions

The interesting part of this project isn't the feature list — it's the trade-offs. Each of these was chosen deliberately and cost something.

### Aurora via the RDS Data API

Lambda and traditional connection pools are a poor match: every cold container opens its own connection, and a traffic spike can exhaust the database before it exhausts compute. The Data API is an HTTP interface, so there is no pool to exhaust and the functions need no VPC attachment.

**Cost:** higher per-query latency than a direct connection, and a non-standard result format that caused a real production bug (below). RDS Proxy was the alternative — it solves pooling but keeps the VPC coupling and adds an hourly charge.

### Aurora Serverless v2 scaled to zero

Minimum capacity is 0 ACUs, so the cluster pauses when idle and charges for storage alone. A 0.5 ACU floor would keep it permanently warm at roughly $43–45/month.

**Cost:** the first request after an idle period waits ~15 seconds while the cluster resumes, and the Data API rejects it outright rather than queueing — it fails with `DatabaseResumingException`. That surfaced as a bug before it surfaced as a saving. The fix was catching that specific exception in the shared database helper and retrying with a delay, so a cold start costs one slow request rather than a failed one.

Correct for a portfolio deployment with sporadic traffic; wrong for a product with paying users, where the fix is a one-line change back to a 0.5 floor. The capacity is a Terraform variable precisely so that decision can be reversed without touching application code.

### HTTP API rather than REST API

Roughly a third of the cost, lower latency, and native JWT authorizer support against Cognito with no custom authorizer Lambda to write or pay for.

**Cost:** no request validation, usage plans or WAF attachment. Acceptable while validation lives in the functions; rate limiting is a known gap.

### A Lambda layer for shared modules

Database access, HTTP helpers, notification writes, content moderation and profile visibility rules live in one layer consumed by every function. The privacy rules in particular must exist in exactly one place — six endpoints need them, and duplicating that logic is precisely how a privacy leak happens.

**Cost:** any layer change redeploys all 26 functions, so a one-line fix has a wide blast radius.

---

## Bugs worth documenting

### A permission check refusing on silently corrupted data

Editing your own comment returned 403. CloudWatch showed a clean 224ms execution with no exception.

The check selected two aliased columns drawn from the same underlying column — the comment author's id and the diagram owner's id, both from `user_id`. The shared database helper keyed result rows on the Data API's column metadata `name` rather than its `label`, so the alias was discarded, both collapsed onto one key, and the author id came back `undefined`. Comparing `undefined` against the caller's id is false, so the check refused — correctly, on wrong data. Nothing threw, which is exactly why the logs were silent.

Fixing it at the shared layer repaired the same latent fault in five other endpoints where author names had been coming back undefined unnoticed.

### Identity absent on routes that permit anonymous access

After adding private profiles, an approved follower was still told the account was private — while signed in.

Identity was read from the API Gateway JWT authorizer's claims. Public profile routes are deliberately open to signed-out visitors, so the authorizer never runs on them, and those claims are absent even when the caller sent a valid token. Every signed-in viewer looked anonymous.

The fix was a separate optional-identity helper documented explicitly as unverified: it may only ever *grant* the visibility a normal signed-in user already has, never authorise a write.

### Configuration drift breaking production silently

The allowed-origin variable reverted to a placeholder during repackaging. Terraform applied the reverted value faithfully — infrastructure as code guarantees the deployed state matches the source, not that the source is correct.

A pre-apply check now fails loudly if the value is wrong. It has caught the same reversion three times since, and it is the failure that most directly motivated a CI/CD pipeline as the next project.

---

## Repository layout

```
backend/          Terraform + Lambda source
  lambda-src/       26 function handlers
  lambda-layer/     shared modules (db, http, notify, moderation, visibility)
  db/               schema and idempotent bootstrap
  *.tf              infrastructure definitions
frontend/         React SPA (Vite)
```

---

## Running it

Terraform state is local in this repository's current form, and the frontend's API endpoint and Cognito identifiers are compiled in at build time. Both are deliberate next steps rather than oversights — see below.

```bash
cd backend
cp terraform.tfvars.example terraform.tfvars   # fill in values
terraform init && terraform apply

cd ../frontend
npm install && npm run build
```

---

## Known gaps

Stated plainly, because an interviewer will find them anyway:

- **No CI/CD** — deployment is a manual sequence, which is what caused the configuration drift above. This is the next project.
- **Local Terraform state** — a single point of failure and unworkable for a team. S3 backend with DynamoDB locking is the first thing to change.
- **No rate limiting** on public read endpoints; unauthenticated reads are scrapeable.
- **Text moderation only** — no image moderation and no user reporting flow. A filter alone is not a moderation strategy.
- **No automated tests.**
- **Frontend configuration compiled in** at build time rather than supplied at runtime, which blocks multi-environment deployment.

---

## What I'd change at scale

- Terraform state to S3 with DynamoDB locking.
- Rate limiting on public reads.
- A read replica or cache for the feed and discover queries, which are read-heavy and tolerate slightly stale data.
- Notification writes onto a queue, off the request path.
- Image moderation and a reporting flow before any real public traffic.

---

Built by Steven Waldron — AWS Solutions Architect, Associate and Professional.
