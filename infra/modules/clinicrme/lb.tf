# HTTPS Load Balancer global (EXTERNAL_MANAGED) → serverless NEG. Sertifikat wildcard terkelola Google lewat otorisasi DNS (OD-140).
# Rute: admin.<domain> → konsol platform; host klinik lain → web; /api/integrations/* (callback gateway) & /healthz → api.

resource "google_compute_global_address" "lb" {
  project    = var.project_id
  name       = "${local.name}-lb-ip"
  depends_on = [google_project_service.apis]
}

resource "google_compute_region_network_endpoint_group" "neg" {
  for_each              = { api = google_cloud_run_v2_service.api.name, web = google_cloud_run_v2_service.frontend["web"].name, admin = google_cloud_run_v2_service.frontend["admin"].name }
  project               = var.project_id
  name                  = "${local.name}-${each.key}-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run { service = each.value }
}

resource "google_compute_backend_service" "be" {
  for_each              = google_compute_region_network_endpoint_group.neg
  project               = var.project_id
  name                  = "${local.name}-${each.key}-be"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.edge.id
  backend { group = each.value.id }
  log_config {
    enable      = true
    sample_rate = 0.2   # cukup untuk analisis trafik per host/tenant; biaya log terkendali (OD-136)
  }
}

resource "google_compute_url_map" "https" {
  project         = var.project_id
  name            = "${local.name}-urlmap"
  default_service = google_compute_backend_service.be["web"].id

  host_rule {
    hosts        = ["admin.${var.domain}"]
    path_matcher = "admin"
  }
  host_rule {
    hosts        = ["*.${var.domain}"]
    path_matcher = "clinic"
  }
  path_matcher {
    name            = "admin"
    default_service = google_compute_backend_service.be["admin"].id
  }
  path_matcher {
    name            = "clinic"
    default_service = google_compute_backend_service.be["web"].id
    path_rule {
      paths   = ["/api/integrations/*", "/healthz"]
      service = google_compute_backend_service.be["api"].id
    }
  }
}

resource "google_certificate_manager_dns_authorization" "domain" {
  project    = var.project_id
  name       = "${local.name}-dns-auth"
  domain     = var.domain
  depends_on = [google_project_service.apis]
}

resource "google_certificate_manager_certificate" "wildcard" {
  project = var.project_id
  name    = "${local.name}-wildcard"
  managed {
    domains            = [var.domain, "*.${var.domain}"]
    dns_authorizations = [google_certificate_manager_dns_authorization.domain.id]
  }
}

resource "google_certificate_manager_certificate_map" "map" {
  project = var.project_id
  name    = "${local.name}-certmap"
}

resource "google_certificate_manager_certificate_map_entry" "entries" {
  for_each     = { apex = var.domain, wildcard = "*.${var.domain}" }
  project      = var.project_id
  name         = "${local.name}-${each.key}"
  map          = google_certificate_manager_certificate_map.map.name
  certificates = [google_certificate_manager_certificate.wildcard.id]
  hostname     = each.value
}

resource "google_compute_ssl_policy" "modern" {
  project         = var.project_id
  name            = "${local.name}-tls"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

resource "google_compute_target_https_proxy" "https" {
  project         = var.project_id
  name            = "${local.name}-https"
  url_map         = google_compute_url_map.https.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.map.id}"
  ssl_policy      = google_compute_ssl_policy.modern.id
}

resource "google_compute_global_forwarding_rule" "https" {
  project               = var.project_id
  name                  = "${local.name}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.https.id
  labels                = local.labels
}

# HTTP → HTTPS
resource "google_compute_url_map" "redirect" {
  project = var.project_id
  name    = "${local.name}-redirect"
  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  project = var.project_id
  name    = "${local.name}-http"
  url_map = google_compute_url_map.redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  project               = var.project_id
  name                  = "${local.name}-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb.id
  port_range            = "80"
  target                = google_compute_target_http_proxy.redirect.id
  labels                = local.labels
}
