locals {
  name   = "clinicrme-${var.env}"
  labels = merge({ app = "clinicrme", env = var.env, managed-by = "terraform" }, var.labels)   # label biaya (OD-136)
  image  = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repo}"
  apis = [
    "run.googleapis.com", "sqladmin.googleapis.com", "compute.googleapis.com", "servicenetworking.googleapis.com",
    "secretmanager.googleapis.com", "artifactregistry.googleapis.com", "certificatemanager.googleapis.com",
    "monitoring.googleapis.com", "logging.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com",
    "sts.googleapis.com", "cloudresourcemanager.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# ---------------------------------------------------------------- Artifact Registry
resource "google_artifact_registry_repository" "images" {
  # checkov:skip=CKV_GCP_84: image tanpa data pasien; enkripsi bawaan Google (CMEK dievaluasi bersama KMS, SC-CRY-03)
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_repo
  format        = "DOCKER"
  labels        = local.labels
  # Simpan 10 versi terakhir per image; sisanya dihapus (biaya penyimpanan)
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions { keep_count = 10 }
  }
  depends_on = [google_project_service.apis]
}

# Log audit akses data untuk Secret Manager & Cloud Storage (siapa membaca secret / mengubah berkas) — PHI tidak ikut dicatat
resource "google_project_iam_audit_config" "data_access" {
  for_each = toset(["secretmanager.googleapis.com", "storage.googleapis.com"])
  project  = var.project_id
  service  = each.value
  audit_log_config { log_type = "ADMIN_READ" }
  audit_log_config { log_type = "DATA_WRITE" }
  dynamic "audit_log_config" {
    for_each = each.value == "secretmanager.googleapis.com" ? [1] : []
    content { log_type = "DATA_READ" }
  }
}
