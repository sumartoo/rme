terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.20" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Bucket dibuat infra/bootstrap; isi nama lewat: terraform init -backend-config="bucket=<project>-tfstate"
  backend "gcs" {
    prefix = "clinicrme/prod"
  }
}

provider "google" {
  project = var.project_id
  region  = "asia-southeast2"
}

variable "project_id" { type = string }
variable "domain" { type = string }
variable "image_tag" { type = string }
variable "google_redirect_uri" { type = string }
variable "allowed_foreign_cidrs" {
  type    = list(string)
  default = []
}
variable "smtp_configured" {
  type    = bool
  default = false
}

module "clinicrme" {
  source                = "../../modules/clinicrme"
  project_id            = var.project_id
  env                   = "prod"
  domain                = var.domain
  image_tag             = var.image_tag
  google_redirect_uri   = var.google_redirect_uri
  allowed_foreign_cidrs = var.allowed_foreign_cidrs
  smtp_configured       = var.smtp_configured
  # Profil A (OD-133): zonal + PITR; ubah ke "REGIONAL" (HA) sebelum klinik ke-3
  db_tier         = "db-custom-2-8192"
  db_availability = "ZONAL"
  max_instances   = { api = 5, worker = 2, web = 3, admin = 2 }
  min_instances   = { api = 1, worker = 1, web = 0, admin = 0 }
}

output "outputs" {
  value = {
    lb_ip               = module.clinicrme.lb_ip
    dns_authorization   = module.clinicrme.dns_authorization_record
    nat_ip              = module.clinicrme.nat_ip
    migrate_job         = module.clinicrme.migrate_job
    services            = module.clinicrme.services
    artifact_registry   = module.clinicrme.artifact_registry
    github_wif_provider = module.clinicrme.github_wif_provider
    deploy_sa           = module.clinicrme.deploy_service_account
    manual_secrets      = module.clinicrme.manual_secrets
  }
}
