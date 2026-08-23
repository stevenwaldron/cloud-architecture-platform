# CI/CD Project — Running Log

Notes taken as the work happens, so the documentation can be written from real
records rather than reconstructed from memory afterwards. The Cloud Architecture
Platform document had to be reconstructed, which is why its smaller decisions
are missing.

Format: what happened, and — where it matters — what the alternative was and why
it was rejected.

---

## Step 1 — Terraform state to S3

**Decision: S3 native locking instead of a DynamoDB lock table.**
Terraform 1.10+ supports `use_lockfile = true`, which takes state locking from S3
itself. Rejected alternative: the conventional DynamoDB lock table, which was the
only option before 1.10 and still appears in most tutorials. Choosing the newer
mechanism removes an entire resource — one less thing to create, pay for, grant
IAM permissions on, and explain. Checked `terraform version` first rather than
assuming; on an older version this would not have been available.

**Decision: created the state bucket with the AWS CLI, not Terraform.**
This is the bootstrapping problem: Terraform cannot store its state in a bucket
that does not exist yet, and it cannot create that bucket without somewhere to
record having done so. Creating it once by hand is the standard resolution.
Rejected alternative: a separate "bootstrap" Terraform config with its own local
state, which solves the same problem with more moving parts.

The bucket was created with versioning, encryption at rest, and public access
fully blocked. Versioning matters more than it first appears: state is
overwritten on every apply, so without it a corrupted write is unrecoverable.
Public access blocking matters because state contains the database master
password in plaintext.

**Bug: `RequestTimeTooSkewed` on every AWS call.**
Symptom: all four `aws s3api` commands failed with "The difference between the
request time and the current time is too large." It read like a credentials or
permissions problem.

Cause: the laptop's system clock had drifted. Every AWS API request is signed
with a timestamp, specifically to prevent replay attacks, and AWS rejects
anything outside roughly a 15-minute window. Nothing to do with IAM at all.

Fix: resynchronised the system clock, then re-ran the commands unchanged.

Worth recording because the error message points nowhere near the actual cause,
and the instinct is to start checking credentials and policies.

**Surprise: the migration plan looked alarming and wasn't.**
After migrating, `terraform plan` reported "2 to add, 37 to change, 2 to
destroy." The instinct is to stop.

Reading it properly: 37 changes were tag updates from a project rename, all
in-place. The two "destroys" were both replacements — a replacement counts once
as an add and once as a destroy. One was `aws_lambda_layer_version.shared`,
which is immutable by design: layer versions are never edited, only republished.
The other was `null_resource.db_schema`, whose trigger is a hash of the schema
file; a comment in that file had changed, so the hash moved and the idempotent
bootstrap re-ran as a no-op.

The check that mattered: confirming no Aurora cluster, Cognito user pool or S3
bucket appeared in the replacement list. Grepping the plan for
"will be destroyed|must be replaced|will be created" turned hundreds of lines
into four, which is a faster and safer read than scrolling.

Also confirmed the migration itself had worked before applying: the plan showed
`aws_vpc.main` with a real `id` and "will be updated in-place". Had migration
failed, Terraform would have proposed *creating* a VPC.

---

## Step 2 — Frontend configuration extraction

**Problem:** the API endpoint and three Cognito identifiers were compiled into
the frontend source. A pipeline cannot hand-edit a source file, so this blocked
CI/CD entirely — and would equally block a second environment later.

**Decision: build-time environment variables rather than a runtime config file.**
Vite inlines `VITE_`-prefixed variables at build time, so this is a small change.
Rejected alternative: fetching a `config.json` at startup, which would let one
built artifact be promoted unchanged between environments. That is the better
answer once multiple environments exist — with build-time variables you promote
the *commit* rather than the *artifact* — but it adds a network request on
startup and a config file to generate and upload, for no benefit while there is
one environment.

**Decision: kept literal fallback values, with a console warning.**
Trade-off between two failure modes. With no fallback, a missing variable breaks
the app loudly — good — but `npm run dev` then requires a `.env` file before it
will run at all. With a fallback, local development works out of the box, but a
future dev build with a missing variable would silently point at the production
database.

Chose the fallback plus a startup warning while there is one environment, with a
comment stating explicitly that the fallbacks must be removed before a second
environment exists. The silent-wrong-backend failure is the more dangerous of the
two, but it cannot occur until there is a second environment to be wrong about.

Noted for later: none of these four values are secret. All are shipped to every
browser and readable in devtools; a Cognito app client ID is designed to be
public. Security rests on JWT verification server-side, not on hiding them.

---

## Still to come

- Step 3 — OIDC trust between GitHub and AWS
- Step 4 — the workflow file
- Step 5 — validate and plan stages
- Step 6 — approval gate
- Step 7 — apply and deploy
