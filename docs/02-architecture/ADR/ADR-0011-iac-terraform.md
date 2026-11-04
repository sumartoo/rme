# ADR-0011 — Infrastructure as Code: Terraform

| | |
|---|---|
| Status | Accepted — disetujui PO 4 Nov 2026 (DEC-016) |
| Tanggal | 3 November 2026 |
| Menyelesaikan | OD-006 |

## Keputusan

- Terraform (open source) dengan provider Google; state di bucket GCS terenkripsi dengan versioning per lingkungan.
- Struktur `infra/modules/*` (network, cloud-sql, cloud-run-service, storage, secrets, monitoring, budget) dan `infra/envs/{dev,staging,prod}`.
- Satu GCP project per lingkungan.
- `terraform plan` dijalankan di CI untuk setiap PR yang mengubah `infra/`; `apply` ke staging/prod membutuhkan persetujuan manual.
- Secret **nilai** tidak disimpan di Terraform; hanya definisi Secret Manager.

## Konsekuensi
- Lingkungan dapat dibuat ulang untuk uji DR (Stage 15).
- Dev lokal tetap memakai Docker Compose.
