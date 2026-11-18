# Cloud Armor (WAF): negara (OD-048), aturan OWASP (pratinjau sampai UAT), batas laju per IP (OD-137).
# Aturan pertama yang cocok mengakhiri evaluasi → urutan: pengecualian (800–900) → geo (1000) → WAF (1100+) → rate limit (2000, conform=allow).
resource "google_compute_security_policy" "edge" {
  project     = var.project_id
  name        = "${local.name}-edge"
  description = "ClinicRME ${var.env}: geo ID, rate limit per IP, OWASP"
  type        = "CLOUD_ARMOR"

  advanced_options_config {
    log_level    = "VERBOSE"
    json_parsing = "STANDARD"
  }

  # Pemeriksaan uptime Google datang dari berbagai negara — hanya /healthz (tanpa data)
  rule {
    action   = "allow"
    priority = 800
    match {
      expr { expression = "request.path == '/healthz'" }
    }
    description = "uptime check"
  }

  dynamic "rule" {
    for_each = length(var.allowed_foreign_cidrs) > 0 ? [1] : []
    content {
      action   = "allow"
      priority = 900
      match {
        versioned_expr = "SRC_IPS_V1"
        config { src_ip_ranges = var.allowed_foreign_cidrs }
      }
      description = "OD-048: pengecualian IP luar negeri yang disetujui PO"
    }
  }

  rule {
    action   = "deny(403)"
    priority = 1000
    match {
      expr { expression = join(" && ", [for c in var.allowed_country_codes : "origin.region_code != '${c}'"]) }
    }
    description = "OD-048: hanya dari negara yang diizinkan"
  }

  rule {
    action   = "rate_based_ban"
    priority = 2000
    match {
      versioned_expr = "SRC_IPS_V1"
      config { src_ip_ranges = ["*"] }
    }
    rate_limit_options {
      conform_action   = "allow"
      exceed_action    = "deny(429)"
      enforce_on_key   = "IP"
      ban_duration_sec = 600
      rate_limit_threshold {
        count        = var.armor_rate_per_minute
        interval_sec = 60
      }
    }
    description = "OD-137: batas permintaan per IP, lebih → blokir 10 menit"
  }

  rule {
    action   = "deny(403)"
    priority = 1100
    preview  = var.waf_preview
    match {
      expr { expression = "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})" }
    }
    description = "OWASP sqli-v33-stable"
  }

  rule {
    action   = "deny(403)"
    priority = 1101
    preview  = var.waf_preview
    match {
      expr { expression = "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})" }
    }
    description = "OWASP xss-v33-stable"
  }

  rule {
    action   = "deny(403)"
    priority = 1102
    preview  = var.waf_preview
    match {
      expr { expression = "evaluatePreconfiguredWaf('lfi-v33-stable', {'sensitivity': 1})" }
    }
    description = "OWASP lfi-v33-stable"
  }

  rule {
    action   = "deny(403)"
    priority = 1103
    preview  = var.waf_preview
    match {
      expr { expression = "evaluatePreconfiguredWaf('rce-v33-stable', {'sensitivity': 1})" }
    }
    description = "OWASP rce-v33-stable"
  }

  rule {
    action   = "deny(403)"
    priority = 1104
    preview  = var.waf_preview
    match {
      expr { expression = "evaluatePreconfiguredWaf('scannerdetection-v33-stable', {'sensitivity': 1})" }
    }
    description = "OWASP scannerdetection-v33-stable"
  }

  rule {
    action   = "deny(403)"
    priority = 1105
    preview  = var.waf_preview
    match {
      expr { expression = "evaluatePreconfiguredWaf('protocolattack-v33-stable', {'sensitivity': 1})" }
    }
    description = "OWASP protocolattack-v33-stable"
  }

  rule {
    action   = "deny(403)"
    priority = 1106
    preview  = false   # CVE-2021-44228 (Log4j) & CVE terkenal lain: risiko salah blokir rendah → langsung ditegakkan
    match {
      expr { expression = "evaluatePreconfiguredWaf('cve-canary')" }
    }
    description = "CVE canary (Log4j dll.)"
  }


  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config { src_ip_ranges = ["*"] }
    }
    description = "bawaan"
  }
}
