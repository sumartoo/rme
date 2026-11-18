# Jaringan privat: Cloud SQL hanya IP privat; Cloud Run memakai Direct VPC egress (tanpa Serverless VPC Connector berbayar).
resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = "${local.name}-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

# Tidak ada VM; semua ingress ke VPC ditolak eksplisit (lalu lintas Cloud Run → Cloud SQL lewat peering privat tetap jalan)
resource "google_compute_firewall" "deny_ingress" {
  project   = var.project_id
  name      = "${local.name}-deny-all-ingress"
  network   = google_compute_network.vpc.id
  direction = "INGRESS"
  priority  = 65534
  deny { protocol = "all" }
  source_ranges = ["0.0.0.0/0"]
  log_config { metadata = "EXCLUDE_ALL_METADATA" }
}

resource "google_compute_subnetwork" "run" {
  project                  = var.project_id
  name                     = "${local.name}-run"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = "10.10.0.0/24"
  private_ip_google_access = true   # web/konsol memanggil API (*.run.app) lewat jalur internal Google
  log_config {
    aggregation_interval = "INTERVAL_10_MIN"
    flow_sampling        = 0.1
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_global_address" "sql_peering" {
  project       = var.project_id
  name          = "${local.name}-sql-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "sql" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql_peering.name]
}

# Keluar ke internet (SATUSEHAT, SMTP) untuk api & worker lewat Cloud NAT dengan IP tetap — dapat didaftarkan ke allowlist mitra
resource "google_compute_router" "nat" {
  project = var.project_id
  name    = "${local.name}-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_address" "nat" {
  project = var.project_id
  name    = "${local.name}-nat-ip"
  region  = var.region
}

resource "google_compute_router_nat" "nat" {
  project                            = var.project_id
  name                               = "${local.name}-nat"
  router                             = google_compute_router.nat.name
  region                             = var.region
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.nat.self_link]
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.run.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
