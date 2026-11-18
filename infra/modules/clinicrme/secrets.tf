# Secret Manager (SC-CRY-04). Nilai yang dibangkitkan Terraform: URL database (berisi password acak) & kunci enkripsi.
# Nilai yang diisi PO langsung di Console (JANGAN lewat chat/repo): OAuth Google, SMTP, kunci gateway pembayaran — dibuat dengan
# nilai awal "belum-diisi" lalu Terraform mengabaikan perubahan berikutnya.
# Catatan: nilai yang dibangkitkan ikut tersimpan di Terraform state → bucket state privat, versioning, akses hanya PO & SA deploy.

locals {
  sql_socket = "/cloudsql/${google_sql_database_instance.main.connection_name}"
  db_url = {
    for k, user in { owner = "clinicrme_owner", app = "crme_api", platform = "crme_platform" } :
    k => "postgres://${user}:${random_password.db[k].result}@localhost/${google_sql_database.app.name}?host=${urlencode(local.sql_socket)}"
  }
  generated = {
    "db-url-owner"     = local.db_url.owner
    "db-url-app"       = local.db_url.app
    "db-url-platform"  = local.db_url.platform
    "db-pass-app"      = random_password.db["app"].result
    "db-pass-platform" = random_password.db["platform"].result
    "encryption-key"   = random_id.encryption_key.hex
  }
  manual = ["google-client-id", "google-client-secret", "smtp-url", "payment-simulator-secret"]
}

resource "random_id" "encryption_key" {
  byte_length = 32   # ENCRYPTION_KEY_HEX (AES-256); KMS envelope menyusul (SC-CRY-03)
}

resource "google_secret_manager_secret" "generated" {
  for_each  = local.generated
  project   = var.project_id
  secret_id = "${local.name}-${each.key}"
  labels    = local.labels
  replication {
    user_managed {
      replicas { location = var.region }   # OD-134: secret juga di Jakarta
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "generated" {
  for_each    = local.generated
  secret      = google_secret_manager_secret.generated[each.key].id
  secret_data = each.value
}

resource "google_secret_manager_secret" "manual" {
  for_each  = toset(local.manual)
  project   = var.project_id
  secret_id = "${local.name}-${each.key}"
  labels    = local.labels
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "manual_placeholder" {
  for_each    = toset(local.manual)
  secret      = google_secret_manager_secret.manual[each.key].id
  secret_data = each.key == "payment-simulator-secret" ? random_password.simulator.result : "belum-diisi"   # gitleaks:allow — placeholder, bukan secret (pragma: allowlist secret)
  lifecycle { ignore_changes = [secret_data, enabled] }
}

resource "random_password" "simulator" {
  length  = 48
  special = false
}
