# Terraform AWS Web Infrastructure Project

## 📌 Project Overview
This project provisions a simple, highly available AWS web infrastructure using **Terraform**. The goal is to demonstrate core AWS and Infrastructure-as-Code fundamentals, including networking, compute, load balancing, and basic security, in a clean and readable Terraform configuration.

This project is designed as a **portfolio piece** to showcase my understanding of AWS concepts and Terraform best practices at an entry–mid cloud engineer level.

---

## 🏗️ Architecture Summary
At a high level, this Terraform project creates:
- A **custom VPC** with a `/16` CIDR block
- **Two public subnets** across different Availability Zones
- An **Internet Gateway** and public route table
- **Two EC2 instances** running a web server
- An **Application Load Balancer (ALB)** to distribute traffic
- A **target group** and listener for HTTP traffic

Traffic flows from the internet → ALB → EC2 instances.

---

## 🌐 Networking Design
**Why a custom VPC?**  
A custom VPC provides full control over IP addressing, routing, and future expansion, rather than relying on AWS default networking.

**CIDR choice (`/16`)**  
A `/16` CIDR block allows for significant subnet expansion and demonstrates planning for scalability.

**Multiple Availability Zones**  
Subnets are spread across two AZs to improve availability and fault tolerance.

---

## 🔐 Security Considerations
**Security Groups**
- HTTP (port 80) is allowed from anywhere for public web access
- SSH (port 22) is allowed for administrative access

**Notes on production readiness**
- SSH access would normally be restricted to a specific IP range or replaced with SSM Session Manager
- HTTPS (TLS) would be added using ACM and an ALB HTTPS listener

---

## 🖥️ Compute Layer (EC2)
**Instance Type**  
`t2.micro` is used because it is eligible for the AWS Free Tier and suitable for lightweight demo workloads.

**User Data Scripts**  
User data is used to automatically install and configure a web server on instance launch. This ensures:
- Consistent configuration
- No manual setup after deployment
- Faster recovery if instances are replaced

---

## ⚖️ Load Balancing
An **Application Load Balancer** is used to:
- Distribute traffic evenly between EC2 instances
- Perform health checks
- Improve fault tolerance

If one EC2 instance becomes unhealthy, the ALB automatically stops routing traffic to it.

---

## 📤 Outputs
The project outputs the **Load Balancer DNS name**, allowing easy access to the deployed web application without manually locating AWS resources.

---

## 🧩 Terraform Design Choices
- Configuration is split across multiple files (`provider.tf`, `variables.tf`, `main.tf`) for clarity and maintainability
- Variables are used for CIDR blocks and configuration values to improve reusability
- The project could be further improved by introducing Terraform modules for networking and compute layers

---

## 🚀 How to Deploy
```bash
terraform init
terraform plan
terraform apply
```

**Command breakdown:**
- `terraform init` initializes providers and backend configuration
- `terraform plan` previews infrastructure changes
- `terraform apply` provisions the resources

---

## 🔄 Improvements & Next Steps
If this project were extended toward production, I would:
- Add Auto Scaling Groups instead of fixed EC2 instances
- Use private subnets for EC2 and public subnets only for the ALB
- Restrict SSH access or replace it with AWS SSM
- Add HTTPS using AWS Certificate Manager
- Introduce remote state storage (S3 + DynamoDB)
- Separate environments (dev / staging / prod)

---

## 🧠 What This Project Demonstrates
- AWS networking fundamentals (VPC, subnets, routing)
- Load balancing and high availability basics
- Infrastructure as Code using Terraform
- Clean project structure and readability
- Awareness of production vs learning tradeoffs

---

## 📎 Notes for Recruiters
This project was intentionally kept simple to emphasize **clarity, correctness, and understanding** over unnecessary complexity. Each design choice reflects core AWS best practices and provides a foundation for more advanced architectures.

