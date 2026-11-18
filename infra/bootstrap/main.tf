# Bootstrap satu kali per project (dijalankan PO dari komputernya, state lokal): bucket state Terraform ber-versioning di Jakarta.
terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.20" }
  }
}

variable "project_id" { type = string }

provider "google" {
  project = var.project_id
  region  = "asia-southeast2"
}

resource "google_project_service" "storage" {
  service            = "storage.googleapis.com"
  disable_on_destroy = false
}

resource "google_storage_bucket" "tfstate" {
  # checkov:skip=CKV_GCP_62: akses state tercatat di Cloud Audit Logs; hanya PO & SA deploy yang berhak
  # checkov:skip=CKV_GCP_114: public access prevention = enforced (cek lama)
  name                        = "${var.project_id}-tfstate"
  location                    = "asia-southeast2"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = true }
  lifecycle_rule {
    condition { num_newer_versions = 30 }
    action { type = "Delete" }
  }
  labels     = { app = "clinicrme", managed-by = "terraform" }
  depends_on = [google_project_service.storage]
}

output "state_bucket" { value = google_storage_bucket.tfstate.name }
