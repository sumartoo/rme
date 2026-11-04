# Stage 15 — GCP Production Infrastructure & Cost Control

| | |
|---|---|
| Phase | F — Produksi |
| Status | Belum dimulai |
| Prasyarat | Stage 14 disetujui |
| Area | `infra/` |

## 1. Tujuan

Menyiapkan infrastruktur produksi yang aman, dapat dipulihkan, terpantau, dan biayanya terkendali.

## 2. Ruang Lingkup

- Cloud Run (API & worker), Cloud SQL PostgreSQL (HA + read replica), Cloud Storage.
- Secret Manager & IAM (least privilege, service account per layanan).
- Cloud Load Balancing + Cloud Armor (WAF).
- Rate limiting & API quota.
- Autoscaling dengan batas maksimum instance.
- Connection pooling & batas koneksi DB.
- Monitoring, logging, alerting, uptime check.
- Budget alert & dashboard biaya; monitoring trafik per tenant.
- Backup otomatis & uji restore.
- Disaster recovery (RPO/RTO).
- Load & stress test.
- Business continuity & rencana downtime.

## 3. Rancangan

### 3.1 Topologi Produksi

| Komponen | Konfigurasi awal usulan |
|---|---|
| Region | `asia-southeast2` (Jakarta) — verifikasi ketersediaan layanan & persyaratan lokasi data |
| Cloud Run API | min instance 1, max instance terbatas (mis. 10), concurrency disesuaikan |
| Cloud Run Worker | min 1, max kecil; atau Cloud Run Jobs untuk batch |
| Cloud Run Web | Next.js standalone, min 0–1, max terbatas |
| Cloud SQL | HA regional, PITR aktif, read replica untuk reporting |
| Koneksi | Cloud SQL connector + pool `pg` (node-postgres); `max_connections` dihitung dari max instance × ukuran pool |
| GCS | bucket per lingkungan, uniform access, lifecycle rule untuk export sementara |
| Network | Serverless VPC access / private IP Cloud SQL |
| WAF | Cloud Armor: OWASP rule set, rate limit per IP, geo policy (OD-048) |

### 3.2 Pengendalian Biaya

- Budget & alert di 50/80/100% per project.
- Label biaya per komponen.
- Max instance di setiap layanan.
- Metrik request & storage per tenant untuk evaluasi paket.
- Review biaya bulanan.

### 3.3 Backup & DR

| Item | Kebijakan usulan |
|---|---|
| Cloud SQL | Backup harian + PITR; retensi sesuai OD-016 |
| GCS | Object versioning untuk dokumen medis |
| Uji restore | Bulanan ke project terpisah, terdokumentasi |
| DR | Runbook pemulihan region; target RPO/RTO dari Stage 1 |

## 4. Deliverable

IaC produksi, `INFRASTRUCTURE.md`, `BACKUP_AND_DR.md`, `COST_CONTROL.md`, `RUNBOOKS/`, laporan load test (`docs/05-testing/PERFORMANCE_TESTS.md`), laporan uji restore, completion report.

## 5. Gate Checklist

- [ ] Load test memenuhi NFR performa pada volume target.
- [ ] Stress test menunjukkan degradasi terkendali (tidak ada kebocoran data/korupsi).
- [ ] Security review infrastruktur (IAM, network, WAF) selesai.
- [ ] Uji restore berhasil dalam target RTO.
- [ ] Budget alert & dashboard biaya aktif; estimasi biaya bulanan disetujui.
- [ ] Project Owner menyetujui Stage 15.

## 6. Open Decision

- **OD-016** — RPO/RTO final.
- **OD-048** — Pembatasan geografis akses.
- **OD-049** — Persyaratan lokasi penyimpanan data di Indonesia (verifikasi regulasi).
