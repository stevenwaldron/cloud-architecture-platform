# --- Aurora Serverless v2 --------------------------------------------------------

# Looks up the latest available Aurora MySQL 8.0-compatible engine version at
# apply time, rather than hardcoding a version string that will eventually
# go stale and cause `apply` to fail with an "invalid engine version" error.
data "aws_rds_engine_version" "aurora_mysql" {
  engine             = "aurora-mysql"
  preferred_versions = ["8.0.mysql_aurora.3.08.0", "8.0.mysql_aurora.3.07.1", "8.0.mysql_aurora.3.06.0"]
}

resource "aws_rds_cluster" "main" {
  cluster_identifier     = "${var.name_prefix}-aurora"
  engine                 = "aurora-mysql"
  engine_mode            = "provisioned" # Serverless v2 uses "provisioned" mode with serverlessv2_scaling_configuration
  engine_version         = data.aws_rds_engine_version.aurora_mysql.version
  database_name          = var.db_name
  master_username        = var.db_master_username
  master_password        = random_password.db_master.result

  db_subnet_group_name   = aws_db_subnet_group.aurora.name
  vpc_security_group_ids = [aws_security_group.aurora.id]

  enable_http_endpoint = true # this is what turns on the RDS Data API

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_capacity
    max_capacity = var.aurora_max_capacity
  }

  skip_final_snapshot = true # portfolio deployment — flip to false and set final_snapshot_identifier before this ever holds real production data
  storage_encrypted   = true

  tags = {
    Project     = "Cloud Architecture Platform"
    Environment = var.environment
  }
}

resource "aws_rds_cluster_instance" "main" {
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.main.engine
  engine_version     = aws_rds_cluster.main.engine_version

  tags = {
    Project = "Cloud Architecture Platform"
  }
}
