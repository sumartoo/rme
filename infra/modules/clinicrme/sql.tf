# Cloud SQL PostgreSQL 16 (OD-133 profil A: zonal + PITR; REGIONAL = HA). Backup & log transaksi di Jakarta (OD-134).
resource "google_sql_database_instance" "main" {
  # checkov:skip=CKV_GCP_79: PostgreSQL 16 = versi yang diuji di dev/CI (paritas skema); naik versi lewat uji terpisah
  # checkov:skip=CKV_GCP_110: pgAudit tidak dipakai — audit aplikasi di app.audit_log (hash chain); log pernyataan berisiko memuat data pasien
  project             = var.project_id
  name                = "${local.name}-pg"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.db_deletion_protection
  depends_on          = [google_service_networking_connection.sql]

  settings {
    edition           = "ENTERPRISE"
    tier              = var.db_tier
    availability_type = var.db_availability
    disk_type         = "PD_SSD"
    disk_size         = var.db_disk_gb
    disk_autoresize   = true
    user_labels       = local.labels

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.vpc.id
      ssl_mode                                      = "TRUSTED_CLIENT_CERTIFICATE_REQUIRED"   # hanya lewat konektor Cloud SQL (mTLS)
      enable_private_path_for_google_cloud_services = true
    }

    backup_configuration {
      enabled                        = true
      location                       = var.region   # OD-134: cadangan tetap di Indonesia
      start_time                     = "18:00"      # 01.00 WIB
      point_in_time_recovery_enabled = true         # RPO ≤ 15 menit (NFR-DR-001)
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 30
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day          = 7    # Minggu
      hour         = 19   # 02.00 WIB — di luar jam praktik (NFR-AVL-002)
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = false
      record_client_address   = false
    }

    # Log tanpa teks/parameter kueri (bisa memuat data pasien); analisis kueri lambat lewat Query Insights (dinormalisasi)
    database_flags {
      name  = "log_min_duration_statement"
      value = "-1"
    }
    database_flags {
      name  = "log_duration"
      value = "on"
    }
    database_flags {
      name  = "log_statement"
      value = "ddl"
    }
    database_flags {
      name  = "log_min_messages"
      value = "error"
    }
    database_flags {
      name  = "log_min_error_statement"
      value = "error"
    }
    database_flags {
      name  = "log_hostname"
      value = "on"
    }
    database_flags {
      name  = "log_connections"
      value = "on"
    }
    database_flags {
      name  = "log_disconnections"
      value = "on"
    }
    database_flags {
      name  = "log_checkpoints"
      value = "on"
    }
    database_flags {
      name  = "log_lock_waits"
      value = "on"
    }
  }
}

resource "google_sql_database" "app" {
  project  = var.project_id
  instance = google_sql_database_instance.main.name
  name     = "clinicrme"
}

# Hanya role pemilik skema dibuat lewat Terraform. Role LOGIN aplikasi & platform (NOBYPASSRLS, bukan owner) dibuat job migrasi
# dari Secret Manager — role bawaan Cloud SQL ikut cloudsqlsuperuser sehingga tidak dipakai untuk aplikasi.
resource "random_password" "db" {
  for_each = toset(["owner", "app", "platform"])
  length   = 40
  special  = false
}

resource "google_sql_user" "owner" {
  project  = var.project_id
  instance = google_sql_database_instance.main.name
  name     = "clinicrme_owner"
  password = random_password.db["owner"].result
}
