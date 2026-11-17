# Stage 15 — Stage Plan

| | |
|---|---|
| Stage | 15 — GCP Production Infrastructure & Cost Control |
| Status | **DRAF — menunggu keputusan PO atas OD-133–OD-141** |
| Project Owner | Sumarto |
| Prasyarat | Stage 14 disetujui (DEC-049) |
| Requirement | NFR-PERF-001–005, NFR-AVL-001/002, NFR-DR-001/002 (99,5% · RPO ≤ 15 menit · RTO ≤ 4 jam, DEC-014) |
| Mode verifikasi | Lokal penuh sampai Actions aktif 1 Des 2026 (DEC-036). Pembuatan resource GCP dilakukan **oleh PO dari komputernya sendiri** (OD-139) |

## 1. Tujuan

Infrastruktur produksi untuk klinik pilot yang:
- aman (IAM least privilege, jaringan privat, WAF, rate limit);
- dapat dipulihkan (backup, PITR, uji restore terdokumentasi);
- terpantau (log, metrik, alert, uptime);
- biayanya terkendali (budget alert, batas instance, estimasi bulanan disetujui PO).

Semua perubahan infrastruktur ditulis sebagai kode (Terraform, OD-006 / DEC-016) sehingga lingkungan dapat dibangun ulang.

## 2. Yang Sudah Ada

| Bagian | Asal | Catatan untuk Stage 15 |
|---|---|---|
| Image Docker API, worker, web, konsol platform | Stage 4 | Dipakai apa adanya di Cloud Run |
| Driver penyimpanan GCS + emulator | Stage 4/9 | Siap; bucket `files` & `exports` |
| Log JSON terstruktur tanpa PHI, `/healthz` & `/readyz` | Stage 3/4 | Dipakai untuk uptime check & alert |
| Migrasi expand-only, worker self-test | Stage 4 | Migrasi dijalankan sebagai Cloud Run Job sebelum revisi baru |
| Lockout login & MFA | Stage 3/6 | **Belum ada rate limit aplikasi** per IP/user/tenant → dikerjakan batch 1 |
| Uji performa laporan 328 ribu kunjungan | Stage 14 | Diulang di infrastruktur target |
| Lingkungan dev di VPS (CR-0003, DEC-030) | Stage 6 | Tetap untuk dev; tidak dipakai untuk data nyata |
| Arsitektur deploy GCP | DEPLOYMENT_ARCHITECTURE.md (DEC-018) | Rujukan; disesuaikan dengan keputusan biaya di OD-133 |

## 3. Batch

| Batch | Isi | Bukti |
|---|---|---|
| **1 — Kesiapan aplikasi & IaC** | Rate limit aplikasi (per IP, user, tenant) dengan respons 429 & audit. Konfigurasi pool DB dari env, koneksi Cloud SQL (socket konektor), graceful shutdown, header keamanan di belakang load balancer. Modul Terraform: project & API, jaringan privat, Cloud SQL, Cloud Run (api, worker, web, konsol) + Job migrasi, Artifact Registry, GCS, Secret Manager, service account per layanan, HTTPS Load Balancer + Cloud Armor, sertifikat wildcard | Uji integrasi rate limit; `terraform fmt/validate`; `tflint`/`checkov` (gratis); plan dengan nilai contoh |
| **2 — Observability & biaya** | Dashboard & alert Cloud Monitoring (p95 > 500 ms, 5xx > 2%, outbox/SATUSEHAT tertunda, koneksi DB, uptime `/healthz`), log-based metric request per tenant, budget alert 50/80/100%, label biaya, retensi log. `COST_CONTROL.md`, estimasi biaya bulanan | Terraform; tinjauan alert dengan uji pemicu di staging |
| **3 — Backup & DR** | Backup harian + PITR Cloud SQL, versioning & retensi bucket dokumen, salinan cadangan kedua sesuai OD-134. Runbook pemulihan (PITR ke instance baru, rotasi secret, region). Uji restore + verifikasi audit chain. `BACKUP_AND_DR.md`, `RUNBOOKS/` | Uji restore lokal (pg_basebackup + WAL) sekarang; uji restore di GCP setelah project ada, dicatat waktunya terhadap RTO |
| **4 — Load test, security review & gate** | Skrip k6 (open source) skenario campuran: login, pendaftaran, antrean, RM, resep, tagihan, laporan. Load test sesuai OD-138, stress test sampai degradasi, cek tidak ada kebocoran data/korupsi. Tinjauan keamanan infrastruktur (IAM, jaringan, WAF, secret). `docs/05-testing/PERFORMANCE_TESTS.md`, completion report | Laporan load/stress test; checklist security review |

Batch 1–2 dan sebagian batch 3–4 dapat dikerjakan **tanpa akun GCP** (kode, Terraform tervalidasi, uji lokal). Penerapan nyata, uji restore
di GCP, dan load test di staging menunggu PO membuat project & billing (§6).

## 4. Open Decision — menunggu PO

| OD | Pertanyaan | Usulan |
|---|---|---|
| **OD-133** | Profil infrastruktur produksi untuk pilot (perkiraan biaya di §5) | **A — GCP hemat** sesuai arsitektur tetapi diperkecil: Cloud Run (api & worker min 1, web & konsol min 0), Cloud SQL Enterprise 2 vCPU/8 GB **zonal** (tanpa HA) + backup harian + PITR, tanpa read replica, HTTPS LB + Cloud Armor. Naik ke **B (HA regional)** sebelum klinik ke-3 atau bila SLA 99,5% perlu dijamin kontrak. Alternatif **C — VPS produksi** di penyedia dalam negeri: termurah, tetapi tanpa HA terkelola dan beban operasional ke PO |
| **OD-134** | Lokasi data & DR — menjawab OD-049 (Permenkes 24/2022 Pasal 22: PSE yang bekerja sama dengan fasyankes wajib punya fasilitas penyimpanan data **di dalam negeri**) | Semua data — database, backup, berkas, log — di **`asia-southeast2` (Jakarta)**. Region GCP lain di luar Indonesia **tidak** dipakai untuk salinan. Karena Jakarta satu-satunya region GCP di Indonesia: salinan cadangan terenkripsi harian ke **penyimpanan kedua di Indonesia di luar GCP** (penyedia dipilih PO; biaya kecil). Risiko diterima untuk pilot: bila seluruh region Jakarta mati, pemulihan dapat > 4 jam |
| **OD-048** | Pembatasan geografis akses | Cloud Armor: aplikasi klinik & konsol hanya dari **Indonesia**, pengecualian daftar IP yang disetujui PO (mis. dokter di luar negeri) dan pemeriksa uptime Google. Ditambah rate limit per IP |
| **OD-135** | Lingkungan | **prod** di project GCP `clinicrme-prod`. **staging** di project terpisah profil minimum (Cloud SQL terkecil, semua min instance 0) yang **dimatikan** saat tidak dipakai — dinyalakan untuk UAT & load test. **dev** tetap di VPS (DEC-030) |
| **OD-136** | Anggaran & pengendalian biaya | Budget prod **USD 400/bulan** (profil A) dengan alert email ke PO di 50/80/100%; staging USD 75/bulan. Max instance: api 5, worker 2, web 3, konsol 2. Retensi log 30 hari. Tanpa komitmen pemakaian (CUD) sampai 3 bulan data biaya nyata |
| **OD-137** | Rate limit | Aplikasi: login 10/menit per IP (di samping lockout akun), API 300 permintaan/menit per pengguna, 3.000/menit per tenant, ekspor 10/jam per pengguna → 429 + header `Retry-After`, tercatat di log (tanpa PHI). Cloud Armor: 600 permintaan/menit per IP, lebih dari itu diblokir 10 menit |
| **OD-138** | Target load & stress test | Load test di **staging** dengan profil yang sama dengan prod: 300 pengguna aktif bersamaan (≈ 10× kebutuhan pilot) skenario campuran 30 menit, target p95 < 500 ms transaksi & error < 1%. Stress test dinaikkan sampai 1.000 pengguna (NFR-PERF-004) atau sampai degradasi, memastikan gagal secara terkendali (429/503) tanpa data rusak/bocor. Alat **k6** (open source, gratis) dijalankan dari VM sementara di Jakarta |
| **OD-139** | Siapa menjalankan Terraform & kredensial | Bootstrap pertama dijalankan **PO dari komputernya** (`gcloud auth login`, lalu `terraform apply` sesuai runbook) — kredensial GCP tidak pernah dikirim lewat chat atau disimpan di repo. Setelah itu deploy dari GitHub Actions memakai **Workload Identity Federation** (tanpa kunci JSON). State Terraform di bucket GCS ber-versioning |
| **OD-140** | Domain produksi | Domain milik PO dengan wildcard `*.domain` untuk subdomain klinik + `admin.domain` untuk konsol, sertifikat wildcard terkelola Google (otorisasi DNS). PO memilih domain (mis. tetap `medika.atoai.id` atau domain baru) |
| **OD-141** | Pemantauan, status & dukungan | Alert Cloud Monitoring ke email PO (kanal lain menyusul). Halaman status statis di bucket GCS. Jendela maintenance di luar jam praktik dengan pemberitahuan ≥ 48 jam (NFR-AVL-002). Respons insiden mengikuti INCIDENT_RESPONSE_PLAN |

## 5. Perkiraan biaya bulanan (kasar)

> Perkiraan kasar dalam USD dari harga publik GCP, termasuk selisih harga region Jakarta. **Wajib divalidasi** dengan Google Cloud Pricing
> Calculator saat project dibuat. Belum termasuk pajak, kurs, dan kredit percobaan akun baru.

| Komponen | A — GCP hemat | B — GCP HA (arsitektur penuh) | C — VPS dalam negeri |
|---|---|---|---|
| Database | Cloud SQL 2 vCPU/8 GB zonal + 50 GB SSD + backup/PITR: ±130–170 | HA regional: ±260–340 | PostgreSQL di VPS + WAL archiving (pgBackRest) |
| Aplikasi | Cloud Run 4 layanan, api & worker selalu menyala: ±70–140 | ±90–160 | 1–2 VPS 4–8 vCPU |
| Load balancer + Cloud Armor | ±30–45 | ±30–45 | Caddy/nginx (gratis) |
| Penyimpanan, log, egress, secret, registry | ±10–30 | ±20–40 | penyimpanan objek lokal ±5–10 |
| Staging (dinyalakan saat perlu) | ±20–60 | ±40–100 | VPS dev yang ada |
| Salinan cadangan kedua di Indonesia (OD-134) | ±5–15 | ±5–15 | ±5–15 |
| **Total perkiraan** | **±265–460** | **±445–700** | **±40–120** |
| SLA terkelola | Tidak untuk DB zonal | Ya (Cloud SQL HA) | Tidak |
| Beban operasional PO | Rendah | Rendah | Tinggi (patch OS, backup, failover manual) |

## 6. Tindakan PO sebelum penerapan nyata

1. Membuat **billing account** & project GCP (`clinicrme-prod`, `clinicrme-staging`), mengaktifkan budget alert. **Jangan kirim detail kartu, kunci JSON, atau kredensial apa pun lewat chat.**
2. Memilih domain (OD-140) dan menyiapkan akses DNS.
3. Memilih penyedia penyimpanan cadangan kedua di Indonesia (OD-134).
4. **Regulasi** (tidak diklaim selesai oleh sistem):
   - pendaftaran PSE lingkup privat;
   - rekomendasi Kementerian Kesehatan untuk kerja sama PSE–fasyankes (Permenkes 24/2022 Pasal 22);
   - konfirmasi bahwa layanan cloud yang dipakai memenuhi syarat "tersertifikasi" (Pasal 20).

   Dikonsultasikan dengan penasihat hukum/regulasi.

## 7. Gate

- [ ] Load test memenuhi NFR performa pada target OD-138
- [ ] Stress test: degradasi terkendali, tanpa kebocoran atau korupsi data
- [ ] Security review infrastruktur (IAM, jaringan, WAF, secret) selesai
- [ ] Uji restore berhasil dalam target RTO, audit chain terverifikasi
- [ ] Budget alert & dashboard biaya aktif; estimasi biaya bulanan disetujui PO
- [ ] Terraform dapat membangun ulang staging dari nol
- [ ] PO menyetujui Stage 15

## 8. Risiko & catatan

- **Biaya** adalah risiko utama (RSK-005). Max instance, budget alert, dan staging yang dimatikan menjadi kontrol utama.
- **Region tunggal di Indonesia.** DR lintas region GCP bertentangan dengan syarat penyimpanan dalam negeri. Lihat OD-134.
- **Uji mutasi lengkap & CI** masih menunggu kuota Actions 1 Des; deploy otomatis ke GCP juga dimulai setelah itu.
- **Klaim regulasi**: dokumen & UI tidak menyebut "sesuai Permenkes" atau "tersertifikasi" tanpa bukti resmi.

## 9. Progres

| Tanggal | Catatan | Bukti |
|---|---|---|
| 18 Nov 2026 | Stage 14 disetujui (DEC-049). Draf rencana & OD Stage 15 disusun | — |
