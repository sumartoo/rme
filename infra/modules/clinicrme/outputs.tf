output "lb_ip" {
  value       = google_compute_global_address.lb.address
  description = "Buat A record `<domain>` dan `*.<domain>` ke IP ini."
}

output "dns_authorization_record" {
  value       = google_certificate_manager_dns_authorization.domain.dns_resource_record
  description = "Record CNAME untuk otorisasi sertifikat wildcard (tambahkan di DNS)."
}

output "nat_ip" {
  value       = google_compute_address.nat.address
  description = "IP keluar tetap api/worker (untuk allowlist mitra bila diminta)."
}

output "migrate_job" {
  value = google_cloud_run_v2_job.migrate.name
}

output "services" {
  value = {
    api    = google_cloud_run_v2_service.api.name
    worker = google_cloud_run_v2_service.worker.name
    web    = google_cloud_run_v2_service.frontend["web"].name
    admin  = google_cloud_run_v2_service.frontend["admin"].name
  }
}

output "artifact_registry" {
  value = local.image
}

output "github_wif_provider" {
  value       = google_iam_workload_identity_pool_provider.github.name
  description = "Isi `workload_identity_provider` di workflow GitHub Actions."
}

output "deploy_service_account" {
  value = google_service_account.deploy.email
}

output "sql_connection_name" {
  value = google_sql_database_instance.main.connection_name
}

output "manual_secrets" {
  value       = [for s in google_secret_manager_secret.manual : s.secret_id]
  description = "Secret yang diisi PO langsung di Console (bukan lewat chat/repo)."
}
