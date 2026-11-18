# Modul infrastruktur ClinicRME (Stage 15, OD-133–OD-141 / DEC-050). Satu modul untuk prod & staging; perbedaan lewat variabel profil.

variable "project_id" {
  type        = string
  description = "Project GCP (mis. clinicrme-prod)."
}

variable "env" {
  type        = string
  description = "Nama lingkungan: prod atau staging."
  validation {
    condition     = contains(["prod", "staging"], var.env)
    error_message = "env harus prod atau staging."
  }
}

variable "region" {
  type        = string
  default     = "asia-southeast2"
  description = "OD-134: semua data di Jakarta (Permenkes 24/2022 Ps. 22). Jangan diubah ke region di luar Indonesia."
  validation {
    condition     = var.region == "asia-southeast2"
    error_message = "OD-134: region wajib asia-southeast2 (Jakarta)."
  }
}

variable "domain" {
  type        = string
  description = "Domain dasar (OD-140), mis. medika.example.id. Klinik di <kode>.domain, konsol di admin.domain."
}

variable "image_tag" {
  type        = string
  description = "Tag/digest image yang dideploy (sama untuk api, worker, web, konsol)."
}

variable "artifact_repo" {
  type        = string
  default     = "clinicrme"
  description = "Nama repositori Artifact Registry (Docker)."
}

# ---- Profil database (OD-133) ----
variable "db_tier" {
  type        = string
  default     = "db-custom-2-8192"
  description = "Profil A: 2 vCPU / 8 GB. Staging: db-custom-1-3840."
}

variable "db_availability" {
  type        = string
  default     = "ZONAL"
  description = "ZONAL (profil A) atau REGIONAL (HA, profil B — sebelum klinik ke-3)."
  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.db_availability)
    error_message = "db_availability harus ZONAL atau REGIONAL."
  }
}

variable "db_disk_gb" {
  type    = number
  default = 50
}

variable "db_deletion_protection" {
  type    = bool
  default = true
}

# ---- Batas instance (OD-136) ----
variable "max_instances" {
  type = object({ api = number, worker = number, web = number, admin = number })
  default = { api = 5, worker = 2, web = 3, admin = 2 }
}

variable "min_instances" {
  type        = object({ api = number, worker = number, web = number, admin = number })
  default     = { api = 1, worker = 1, web = 0, admin = 0 }
  description = "Staging: semua 0 kecuali worker saat dipakai (OD-135)."
}

# ---- Akses (OD-048, OD-137) ----
variable "allowed_country_codes" {
  type        = list(string)
  default     = ["ID"]
  description = "OD-048: negara yang diizinkan Cloud Armor."
}

variable "allowed_foreign_cidrs" {
  type        = list(string)
  default     = []
  description = "OD-048: pengecualian IP di luar Indonesia yang disetujui PO (mis. dokter di luar negeri)."
}

variable "armor_rate_per_minute" {
  type        = number
  default     = 600
  description = "OD-137: permintaan per menit per IP sebelum diblokir 10 menit."
}

variable "waf_preview" {
  type        = bool
  default     = true
  description = "Aturan WAF OWASP dalam mode pratinjau (hanya dicatat) sampai dievaluasi saat UAT, agar teks klinis tidak salah diblokir."
}

# ---- Deploy dari GitHub (OD-139) ----
variable "github_repository" {
  type        = string
  default     = "AtoAIs/atoai-rme-v2"
  description = "Repo yang boleh deploy lewat Workload Identity Federation (tanpa kunci JSON)."
}

variable "labels" {
  type    = map(string)
  default = {}
}

variable "google_redirect_uri" {
  type        = string
  description = "URI callback login Google (IAM-FR-002) pada host klinik, mis. https://<kode-klinik>.<domain>/api/v1/auth/google/callback."
}

variable "mail_from" {
  type    = string
  default = "ClinicRME <no-reply@clinicrme.id>"
}

variable "smtp_configured" {
  type        = bool
  default     = false
  description = "true setelah PO mengisi secret smtp-url di Console (tanpa itu email notifikasi tertahan PENDING)."
}
