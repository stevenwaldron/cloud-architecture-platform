# --- Schema bootstrap ------------------------------------------------------------
# Runs db/bootstrap.sh once, right after the Aurora instance is available,
# applying db/schema.sql via the RDS Data API. Re-runs automatically if the
# schema file changes (tracked via its hash), safe to re-run any time since
# every statement is CREATE TABLE IF NOT EXISTS.

resource "null_resource" "db_schema" {
  triggers = {
    schema_hash = filesha256("${path.module}/db/schema.sql")
    cluster_id  = aws_rds_cluster.main.id
  }

  provisioner "local-exec" {
    command = "bash ${path.module}/db/bootstrap.sh '${aws_rds_cluster.main.arn}' '${aws_secretsmanager_secret.db_master.arn}' '${var.db_name}' '${var.aws_region}'"
  }

  depends_on = [
    aws_rds_cluster_instance.main,
    aws_secretsmanager_secret_version.db_master,
  ]
}
