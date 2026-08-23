#!/bin/bash
# Applies db/schema.sql to the newly created Aurora cluster via the RDS Data
# API. Run automatically by Terraform (see db_bootstrap.tf) right after the
# cluster comes up — you shouldn't need to run this by hand, but it's safe to
# re-run manually any time.
#
# Every CREATE TABLE uses IF NOT EXISTS, which MySQL handles natively. A few
# statements (like ADD COLUMN) can't use that same trick — MySQL, unlike
# MariaDB, doesn't support "IF NOT EXISTS" on ADD COLUMN — so this script
# tolerates the specific "already exists" error codes those statements
# produce on a re-run (1060 duplicate column, 1061 duplicate key, 1050 table
# already exists) and continues, while still failing loudly on any other,
# genuine error.
#
# Separately: Aurora auto-pauses when idle and takes time to resume on the
# first request after a pause, returning DatabaseResumingException in the
# meantime rather than waiting for you. Each statement below retries on that
# specific error rather than failing immediately — the same pattern already
# used in the Lambda functions' shared/db.js, just not previously applied
# here too.
set -uo pipefail

CLUSTER_ARN="$1"
SECRET_ARN="$2"
DB_NAME="$3"
REGION="$4"
SCHEMA_FILE="$(dirname "$0")/schema.sql"

echo "Waiting for Aurora cluster to accept Data API connections..."
sleep 15

python3 - "$SCHEMA_FILE" <<'PYEOF' > /tmp/cloud-architecture-platform_statements.txt
import sys, re
with open(sys.argv[1]) as f:
    content = f.read()
content = re.sub(r'--.*', '', content)
statements = [s.strip() for s in content.split(';') if s.strip()]
with open('/tmp/cloud-architecture-platform_statements.txt', 'w') as out:
    for s in statements:
        out.write(s.replace('\n', ' ') + '\n---STATEMENT-BOUNDARY---\n')
PYEOF

run_statement() {
  local sql="$1"
  local max_attempts=6
  local delay=8
  local attempt=1
  while [ $attempt -le $max_attempts ]; do
    ERR_OUTPUT=$(aws rds-data execute-statement \
      --region "$REGION" \
      --resource-arn "$CLUSTER_ARN" \
      --secret-arn "$SECRET_ARN" \
      --database "$DB_NAME" \
      --sql "$sql" 2>&1 >/dev/null)
    STATUS=$?
    if [ $STATUS -eq 0 ]; then
      return 0
    fi
    if echo "$ERR_OUTPUT" | grep -qE "Error code: (1060|1061|1050)"; then
      echo "  -> already applied, skipping (this is expected on a re-run)"
      return 0
    fi
    if echo "$ERR_OUTPUT" | grep -q "DatabaseResumingException"; then
      echo "  -> Aurora is resuming from auto-pause, attempt $attempt/$max_attempts — waiting ${delay}s"
      sleep $delay
      attempt=$((attempt+1))
      continue
    fi
    echo "$ERR_OUTPUT" >&2
    return 1
  done
  echo "Gave up after $max_attempts attempts waiting for Aurora to resume." >&2
  return 1
}

STATEMENT=""
FAILED=0
while IFS= read -r line; do
  if [ "$line" == "---STATEMENT-BOUNDARY---" ]; then
    if [ -n "$STATEMENT" ]; then
      echo "Running: $(echo "$STATEMENT" | cut -c1-60)..."
      if ! run_statement "$STATEMENT"; then
        FAILED=1
      fi
      STATEMENT=""
    fi
  else
    STATEMENT="$STATEMENT $line"
  fi
done < /tmp/cloud-architecture-platform_statements.txt

if [ $FAILED -ne 0 ]; then
  echo "Schema apply hit a genuine error — see above." >&2
  exit 1
fi

echo "Schema applied successfully."
