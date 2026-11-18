# Infrastruktur GCP ClinicRME (Stage 15)

Terraform untuk lingkungan **prod** dan **staging** di Google Cloud. Keputusan rujukan ada di DEC-050 (OD-133–OD-141, OD-048), dengan rincian di [`docs/reports/stage-15/STAGE_PLAN.md`](../docs/reports/stage-15/STAGE_PLAN.md). Lingkungan **dev** tetap di VPS (DEC-030).

> **Keamanan kredensial (OD-139).** Semua langkah di bawah dijalankan **dari komputer PO** dengan akun Google PO.
> - Jangan pernah mengirim kunci JSON, isi `terraform.tfvars`, isi state, atau nilai secret lewat chat atau email.
> - Jangan menyimpan hal-hal tersebut di repo; `.gitignore` sudah menolak `*.tfvars` dan `*.tfstate`.
> - Secret aplikasi diisi langsung di Secret Manager Console.

## Isi

| Folder | Isi |
|---|---|
| `bootstrap/` | Bucket state Terraform di Jakarta, versioning, akses privat. State bootstrap disimpan lokal di komputer PO |
| `modules/clinicrme/` | Seluruh komponen (lihat tabel di bawah) |
| `envs/prod`, `envs/staging` | Akar konfigurasi per lingkungan. Profil prod = A (OD-133); staging = minimum (OD-135) |

Komponen di `modules/clinicrme/`:

| Komponen | Isi |
|---|---|
| Region | `asia-southeast2`, dikunci oleh validasi variabel (OD-134) |
| Jaringan | VPC privat, Direct VPC egress, Cloud NAT dengan IP tetap, firewall deny-all |
| Database | Cloud SQL PostgreSQL 16: IP privat, mTLS konektor, backup harian + PITR 7 hari di Jakarta, log tanpa teks kueri |
| Aplikasi | Cloud Run `api`, `worker`, `web`, `admin` + Job `migrate` |
| Akses & secret | Service account per layanan, Secret Manager (replika Jakarta) |
| Penyimpanan | Bucket berkas (versioning) & ekspor (dihapus otomatis setelah 7 hari) |
| Load balancer & WAF | HTTPS LB global + sertifikat wildcard terkelola; Cloud Armor (geo ID, WAF OWASP pratinjau, CVE canary, 600 req/menit/IP) |
| Lainnya | Artifact Registry; Workload Identity Federation untuk GitHub Actions; log audit akses data untuk secret & storage |

## Prasyarat di komputer PO

- [Google Cloud CLI](https://cloud.google.com/sdk/docs/install), Terraform ≥ 1.6, dan Docker Desktop.
- Billing account GCP aktif, dengan **budget alert** yang dibuat dulu di Console sebelum apa pun (OD-136): prod USD 400, staging USD 75; alert 50/80/100% ke email PO. Budget sebagai kode menyusul di batch 2.
- Domain (OD-140) dengan akses mengubah DNS.

## Langkah pertama (sekali per lingkungan; contoh prod)

```powershell
# 1. Login & project
gcloud auth login
gcloud auth application-default login
gcloud projects create clinicrme-prod            # atau pakai project yang sudah dibuat di Console
gcloud billing projects link clinicrme-prod --billing-account=XXXXXX-XXXXXX-XXXXXX
gcloud config set project clinicrme-prod

# 2. Bucket state
cd infra\bootstrap
terraform init
terraform apply -var="project_id=clinicrme-prod"

# 3. Konfigurasi lingkungan
cd ..\envs\prod
copy terraform.tfvars.example terraform.tfvars   # lalu isi domain, image_tag, google_redirect_uri
terraform init -backend-config="bucket=clinicrme-prod-tfstate"

# 4. Artifact Registry dulu (Cloud Run butuh image yang sudah ada)
terraform apply -target="module.clinicrme.google_artifact_registry_repository.images"

# 5. Build & push image (tag sama dengan image_tag), dari root repo
gcloud auth configure-docker asia-southeast2-docker.pkg.dev
$R="asia-southeast2-docker.pkg.dev/clinicrme-prod/clinicrme"; $T="v0.15.0"
docker build -f docker/node-app.Dockerfile --build-arg APP=api    -t "$R/api:$T" .
docker build -f docker/node-app.Dockerfile --build-arg APP=worker -t "$R/worker:$T" .
docker build -f docker/web.Dockerfile      --build-arg APP=web    -t "$R/web:$T" .
docker build -f docker/web.Dockerfile      --build-arg APP=platform-admin -t "$R/platform-admin:$T" .
docker push "$R/api:$T"; docker push "$R/worker:$T"; docker push "$R/web:$T"; docker push "$R/platform-admin:$T"

# 6. Semua komponen
cd infra\envs\prod
terraform plan -out=plan.tfplan     # PERIKSA dulu: tidak boleh ada "destroy" pada database
terraform apply plan.tfplan
terraform output outputs            # lb_ip, record DNS otorisasi sertifikat, dll.
```

## Setelah apply

1. **DNS**: A record `domain` dan `*.domain` ke `lb_ip`, plus record CNAME `dns_authorization`. Sertifikat aktif dalam ±15–60 menit.
2. **Secret manual** di Secret Manager Console (*Add new version*), daftarnya ada di `manual_secrets`:
   - `google-client-id` & `google-client-secret` (OAuth Google);
   - `smtp-url` (setelah diisi, set `smtp_configured = true` lalu apply lagi);
   - `payment-simulator-secret` sudah dibangkitkan otomatis.
3. **Migrasi DB & role aplikasi**:
   ```powershell
   gcloud run jobs execute clinicrme-prod-migrate --region=asia-southeast2 --wait
   ```
   Job ini menerapkan migrasi, lalu membuat role `crme_api` dan `crme_platform` (NOBYPASSRLS, bukan owner) dengan password dari Secret Manager. Jalankan ulang job setiap rilis, **sebelum** revisi baru menerima traffic.
4. **Cek**:
   ```powershell
   curl https://demo.<domain>/healthz
   ```
   Hasil yang diharapkan 200. Log Cloud Run tidak boleh menampilkan error konfigurasi.

## Hal penting yang perlu diketahui

- **`APP_ENV=prod` menolak gateway pembayaran simulator** (OD-039). Revisi API prod baru dapat berjalan setelah penyedia QRIS nyata dipilih dan adapternya dibuat (pengingat sebelum pilot). Sampai saat itu, uji di **staging**.
- **Akun admin platform pertama** di prod dibuat dengan perintah khusus yang menyusul di batch 2. Seed data sintetis **tidak** dipakai di prod.
- **Password & kunci yang dibangkitkan Terraform ikut tersimpan di state.** Karena itu bucket state wajib privat dan hanya PO serta SA deploy yang berhak membacanya.
- **WAF OWASP masih mode pratinjau** (`waf_preview = true`): pelanggaran hanya dicatat. Setelah UAT tanpa salah blokir, ubah menjadi `false`. Aturan CVE canary sudah ditegakkan.
- **Database zonal (profil A)**: belum ada SLA terkelola. Untuk HA, ubah `db_availability = "REGIONAL"` di `envs/prod/main.tf` sebelum klinik ke-3 (OD-133). Biaya database kira-kira 2×.
- **Batas instance**: api 5, worker 2, web 3, konsol 2 (OD-136). Pool DB per instance api 10 + 4 (konsol); total koneksi maksimum ±100.

## Mematikan staging (OD-135)

Staging cukup dinyalakan saat UAT atau load test:

```powershell
gcloud sql instances patch clinicrme-staging-pg --activation-policy=NEVER     # hentikan DB (biaya CPU/RAM berhenti; disk tetap)
gcloud run services update clinicrme-staging-worker --region=asia-southeast2 --min-instances=0
# Menyalakan lagi:
gcloud sql instances patch clinicrme-staging-pg --activation-policy=ALWAYS
gcloud run services update clinicrme-staging-worker --region=asia-southeast2 --min-instances=1
```

## Pemeriksaan statis (tanpa akun GCP)

```bash
checkov -d infra --framework terraform --compact     # 70 lulus, 0 gagal, 16 dilewati dengan alasan tertulis di kode
terraform -chdir=infra/envs/prod init -backend=false && terraform -chdir=infra/envs/prod validate
```

Di workspace pengembangan, unduhan Terraform/registry diblokir. Karena itu `validate`/`plan` pertama dijalankan PO di komputernya (atau di CI setelah 1 Des). Sintaks sudah diperiksa parser HCL, dan referensi resource/variabel diperiksa skrip.
