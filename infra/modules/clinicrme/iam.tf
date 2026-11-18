# Service account per layanan, least privilege (DEPLOYMENT_ARCHITECTURE §3). Tidak ada SA yang punya akses IAM/Terraform.
locals {
  runtime_sa = {
    api    = "API klinik & konsol platform"
    worker = "Worker pg-boss"
    web    = "Web klinik & konsol (Next.js)"
    migrate = "Job migrasi DB"
  }
  secret_access = {
    api     = ["db-url-app", "db-url-platform", "encryption-key"]
    worker  = ["db-url-owner", "encryption-key"]
    migrate = ["db-url-owner", "db-pass-app", "db-pass-platform"]
    web     = []
  }
  manual_secret_access = {
    api    = ["google-client-id", "google-client-secret", "payment-simulator-secret"]
    worker = ["smtp-url"]
  }
}

resource "google_service_account" "runtime" {
  for_each     = local.runtime_sa
  project      = var.project_id
  account_id   = "${local.name}-${each.key}"
  display_name = "ClinicRME ${var.env} — ${each.value}"
}

resource "google_secret_manager_secret_iam_member" "generated" {
  for_each = { for p in flatten([for sa, list in local.secret_access : [for s in list : { sa = sa, s = s }]]) : "${p.sa}/${p.s}" => p }
  project   = var.project_id
  secret_id = google_secret_manager_secret.generated[each.value.s].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime[each.value.sa].email}"
}

resource "google_secret_manager_secret_iam_member" "manual" {
  for_each = { for p in flatten([for sa, list in local.manual_secret_access : [for s in list : { sa = sa, s = s }]]) : "${p.sa}/${p.s}" => p }
  project   = var.project_id
  secret_id = google_secret_manager_secret.manual[each.value.s].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime[each.value.sa].email}"
}

# Koneksi Cloud SQL (socket) untuk api, worker, job migrasi
resource "google_project_iam_member" "sql_client" {
  for_each = toset(["api", "worker", "migrate"])
  project  = var.project_id
  role     = "roles/cloudsql.client"
  member   = "serviceAccount:${google_service_account.runtime[each.key].email}"
}

# Log & metrik
resource "google_project_iam_member" "telemetry" {
  for_each = { for p in setproduct(keys(local.runtime_sa), ["roles/logging.logWriter", "roles/monitoring.metricWriter"]) : "${p[0]}/${p[1]}" => p }
  project  = var.project_id
  role     = each.value[1]
  member   = "serviceAccount:${google_service_account.runtime[each.value[0]].email}"
}
