# Cloud Run: api, worker, web klinik, konsol platform + Job migrasi. Semua keluar lewat VPC (Direct VPC egress → Cloud NAT IP tetap).
locals {
  common_env = {
    APP_ENV   = var.env
    NODE_ENV  = "production"
    LOG_LEVEL = "info"
  }
  storage_env = {
    STORAGE_DRIVER         = "gcs"
    STORAGE_BUCKET_FILES   = google_storage_bucket.files.name
    STORAGE_BUCKET_EXPORTS = google_storage_bucket.exports.name
  }
  api_env = merge(local.common_env, local.storage_env, {
    BASE_DOMAIN         = var.domain
    COOKIE_SECURE       = "true"
    DB_POOL_MAX         = "10"
    PLATFORM_DB_POOL_MAX = "4"
    EXPORT_TTL_HOURS    = "24"
    GOOGLE_ISSUER       = "https://accounts.google.com"
    GOOGLE_REDIRECT_URI = var.google_redirect_uri
  })
  api_secrets = {
    DATABASE_URL             = google_secret_manager_secret.generated["db-url-app"].secret_id
    PLATFORM_DATABASE_URL    = google_secret_manager_secret.generated["db-url-platform"].secret_id
    ENCRYPTION_KEY_HEX       = google_secret_manager_secret.generated["encryption-key"].secret_id
    GOOGLE_CLIENT_ID         = google_secret_manager_secret.manual["google-client-id"].secret_id
    GOOGLE_CLIENT_SECRET     = google_secret_manager_secret.manual["google-client-secret"].secret_id
    PAYMENT_SIMULATOR_SECRET = google_secret_manager_secret.manual["payment-simulator-secret"].secret_id
  }
  worker_env = merge(local.common_env, local.storage_env, {
    WORKER_TMP_DIR      = "/tmp"
    EXPORT_TTL_HOURS    = "24"
    MAIL_FROM           = var.mail_from
    CLINIC_URL_TEMPLATE = "https://{code}.${var.domain}"
  })
  worker_secrets = merge({
    WORKER_DATABASE_URL = google_secret_manager_secret.generated["db-url-owner"].secret_id
    ENCRYPTION_KEY_HEX  = google_secret_manager_secret.generated["encryption-key"].secret_id
  }, var.smtp_configured ? { SMTP_URL = google_secret_manager_secret.manual["smtp-url"].secret_id } : {})
  vpc_egress = {
    network    = google_compute_network.vpc.id
    subnetwork = google_compute_subnetwork.run.id
  }
}

resource "google_cloud_run_v2_service" "api" {
  project             = var.project_id
  name                = "${local.name}-api"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"   # hanya lewat LB (+ panggilan internal web dari VPC)
  deletion_protection = var.env == "prod"
  labels              = local.labels

  template {
    service_account                  = google_service_account.runtime["api"].email
    max_instance_request_concurrency = 40
    timeout                          = "60s"
    scaling {
      min_instance_count = var.min_instances.api
      max_instance_count = var.max_instances.api
    }
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = local.vpc_egress.network
        subnetwork = local.vpc_egress.subnetwork
      }
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance { instances = [google_sql_database_instance.main.connection_name] }
    }
    containers {
      image = "${local.image}/api:${var.image_tag}"
      ports { container_port = 3000 }
      resources {
        limits            = { cpu = "1", memory = "1Gi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = local.api_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.api_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      startup_probe {
        http_get { path = "/readyz" }
        initial_delay_seconds = 2
        period_seconds        = 3
        failure_threshold     = 20
      }
      liveness_probe {
        http_get { path = "/healthz" }
        period_seconds = 30
      }
    }
  }
  depends_on = [google_secret_manager_secret_version.generated, google_secret_manager_secret_version.manual_placeholder,
    google_secret_manager_secret_iam_member.generated, google_secret_manager_secret_iam_member.manual]
}

resource "google_cloud_run_v2_service" "worker" {
  project             = var.project_id
  name                = "${local.name}-worker"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"   # tanpa ingress publik; endpoint /healthz hanya untuk probe
  deletion_protection = var.env == "prod"
  labels              = local.labels

  template {
    service_account = google_service_account.runtime["worker"].email
    scaling {
      min_instance_count = var.min_instances.worker
      max_instance_count = var.max_instances.worker
    }
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = local.vpc_egress.network
        subnetwork = local.vpc_egress.subnetwork
      }
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance { instances = [google_sql_database_instance.main.connection_name] }
    }
    containers {
      image = "${local.image}/worker:${var.image_tag}"
      ports { container_port = 3000 }
      resources {
        limits   = { cpu = "1", memory = "1Gi" }
        cpu_idle = false   # job pg-boss berjalan terus (CPU selalu dialokasikan)
      }
      dynamic "env" {
        for_each = local.worker_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.worker_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      startup_probe {
        http_get { path = "/healthz" }
        period_seconds    = 5
        failure_threshold = 24
      }
      liveness_probe {
        http_get { path = "/healthz" }
        period_seconds = 30
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.generated, google_secret_manager_secret_iam_member.manual]
}

# Web klinik & konsol platform (Next.js standalone) — memanggil API lewat URL internal (VPC + Private Google Access)
resource "google_cloud_run_v2_service" "frontend" {
  for_each            = { web = "web", admin = "platform-admin" }
  project             = var.project_id
  name                = "${local.name}-${each.key}"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  deletion_protection = var.env == "prod"
  labels              = local.labels

  template {
    service_account                  = google_service_account.runtime["web"].email
    max_instance_request_concurrency = 80
    scaling {
      min_instance_count = var.min_instances[each.key]
      max_instance_count = var.max_instances[each.key]
    }
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = local.vpc_egress.network
        subnetwork = local.vpc_egress.subnetwork
      }
    }
    containers {
      image = "${local.image}/${each.value}:${var.image_tag}"
      ports { container_port = 3000 }
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = true
      }
      env {
        name  = "API_INTERNAL_URL"
        value = google_cloud_run_v2_service.api.uri
      }
      env {
        name  = "BASE_DOMAIN"
        value = var.domain
      }
    }
  }
}

# Aplikasi punya autentikasi sendiri; akses jaringan dibatasi ingress (LB/VPC) + Cloud Armor
resource "google_cloud_run_v2_service_iam_member" "public" {
  for_each = {
    api   = google_cloud_run_v2_service.api.name
    web   = google_cloud_run_v2_service.frontend["web"].name
    admin = google_cloud_run_v2_service.frontend["admin"].name
  }
  project  = var.project_id
  location = var.region
  name     = each.value
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Job migrasi (expand-only) + role LOGIN aplikasi & platform — dijalankan sebelum revisi baru menerima traffic
resource "google_cloud_run_v2_job" "migrate" {
  project             = var.project_id
  name                = "${local.name}-migrate"
  location            = var.region
  deletion_protection = var.env == "prod"
  labels              = local.labels

  template {
    task_count = 1
    template {
      service_account = google_service_account.runtime["migrate"].email
      max_retries     = 0
      timeout         = "900s"
      vpc_access {
        egress = "ALL_TRAFFIC"
        network_interfaces {
          network    = local.vpc_egress.network
          subnetwork = local.vpc_egress.subnetwork
        }
      }
      volumes {
        name = "cloudsql"
        cloud_sql_instance { instances = [google_sql_database_instance.main.connection_name] }
      }
      containers {
        image = "${local.image}/api:${var.image_tag}"
        args  = ["migrate.js"]
        env {
          name  = "APP_DB_USER"
          value = "crme_api"
        }
        env {
          name  = "PLATFORM_DB_USER"
          value = "crme_platform"
        }
        dynamic "env" {
          for_each = {
            MIGRATION_DATABASE_URL = google_secret_manager_secret.generated["db-url-owner"].secret_id
            APP_DB_PASSWORD        = google_secret_manager_secret.generated["db-pass-app"].secret_id
            PLATFORM_DB_PASSWORD   = google_secret_manager_secret.generated["db-pass-platform"].secret_id
          }
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.generated]
}
