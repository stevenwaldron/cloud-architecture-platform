# --- Minimal VPC for Aurora ----------------------------------------------------
# Aurora Serverless v2 must live in a VPC with subnets across 2+ AZs, but
# since Lambda reaches it through the RDS Data API (a regional AWS endpoint)
# rather than a direct VPC connection, these subnets never need internet
# access. No NAT Gateway, no Internet Gateway — keeps this both simpler and
# effectively free, since NAT Gateways are one of the few things in this
# stack that would otherwise cost real money per hour.

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name    = "${var.name_prefix}-vpc"
    Project = "Cloud Architecture Platform"
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_subnet" "db_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.1.0/24"
  availability_zone = data.aws_availability_zones.available.names[0]

  tags = {
    Name = "${var.name_prefix}-db-subnet-a"
  }
}

resource "aws_subnet" "db_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.2.0/24"
  availability_zone = data.aws_availability_zones.available.names[1]

  tags = {
    Name = "${var.name_prefix}-db-subnet-b"
  }
}

resource "aws_db_subnet_group" "aurora" {
  name       = "${var.name_prefix}-aurora-subnets"
  subnet_ids = [aws_subnet.db_a.id, aws_subnet.db_b.id]

  tags = {
    Name = "${var.name_prefix}-aurora-subnets"
  }
}

resource "aws_security_group" "aurora" {
  name        = "${var.name_prefix}-aurora-sg"
  description = "Aurora cluster security group - Data API access does not need inbound rules from Lambda, this only matters if a client connects directly"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.name_prefix}-aurora-sg"
  }
}
