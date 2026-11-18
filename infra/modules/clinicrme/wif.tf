# Deploy dari GitHub Actions tanpa kunci JSON (OD-139): Workload Identity Federation dibatasi ke satu repo.
resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "${local.name}-github"
  display_name              = "GitHub ${var.env}"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  # checkov:skip=CKV_GCP_125: kondisi membatasi repository + ref (tag rilis untuk prod); klaim sub tidak dapat dicocokkan persis untuk tag berversi
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  # Hanya repo ClinicRME; prod hanya dari tag rilis (DEPLOYMENT_ARCHITECTURE §4), staging dari main
  attribute_condition = var.env == "prod" ? "assertion.repository == '${var.github_repository}' && assertion.ref.startsWith('refs/tags/v')" : "assertion.repository == '${var.github_repository}' && (assertion.ref == 'refs/heads/main' || assertion.ref.startsWith('refs/tags/v'))"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}

resource "google_service_account" "deploy" {
  project      = var.project_id
  account_id   = "${local.name}-deploy"
  display_name = "ClinicRME ${var.env} — deploy dari GitHub"
}

resource "google_service_account_iam_member" "deploy_wif" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

# Hak minimum deploy: dorong image, perbarui revisi Cloud Run & jalankan job migrasi, bertindak sebagai SA runtime saja
resource "google_artifact_registry_repository_iam_member" "deploy_push" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_project_iam_member" "deploy_run" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_service_account_iam_member" "deploy_act_as" {
  for_each           = google_service_account.runtime
  service_account_id = each.value.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}
