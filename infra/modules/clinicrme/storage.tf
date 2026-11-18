# Bucket berkas (dokumen medis, logo, hasil lab) & ekspor sementara. Uniform access, tanpa akses publik, di Jakarta (OD-134).
resource "google_storage_bucket" "files" {
  # checkov:skip=CKV_GCP_62: akses berkas diaudit aplikasi (audit_log) + Cloud Audit Logs DATA_WRITE (main.tf)
  project                     = var.project_id
  name                        = "${var.project_id}-files"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels
  versioning { enabled = true }   # cegah hapus/timpa dokumen medis (BACKUP & DR)
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 90
      with_state                 = "ARCHIVED"
    }
    action { type = "Delete" }
  }
  lifecycle_rule {
    condition { age = 365 }
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket" "exports" {
  # checkov:skip=CKV_GCP_62: unduhan ekspor diaudit aplikasi (REPORT_EXPORT_DOWNLOADED, EXPORT_DOWNLOADED)
  # checkov:skip=CKV_GCP_78: berkas sementara (tautan 24 jam); versioning justru menahan salinan yang harus terhapus
  project                     = var.project_id
  name                        = "${var.project_id}-exports"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels
  # Tautan ekspor berlaku 24 jam (dihapus worker); aturan ini pengaman bila job tertunda
  lifecycle_rule {
    condition { age = 7 }
    action { type = "Delete" }
  }
  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "objects" {
  for_each = { for p in setproduct(["api", "worker"], ["files", "exports"]) : "${p[0]}/${p[1]}" => p }
  bucket   = each.value[1] == "files" ? google_storage_bucket.files.name : google_storage_bucket.exports.name
  role     = "roles/storage.objectUser"
  member   = "serviceAccount:${google_service_account.runtime[each.value[0]].email}"
}
