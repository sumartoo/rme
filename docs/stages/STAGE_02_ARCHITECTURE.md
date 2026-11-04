# Stage 2 — Arsitektur Sistem & Database

| | |
|---|---|
| Phase | A — Inisiasi & Desain |
| Status | **Selesai — disetujui 4 Nov 2026** |
| Prasyarat | Stage 1 disetujui |
| Stage berikutnya | Stage 3 — Security Foundation |

## 1. Tujuan

Menetapkan fondasi teknis: arsitektur aplikasi, database, multi-tenancy, API contract, audit, event, integrasi, dan deployment.

## 2. Ruang Lingkup

- Desain modular monolith NestJS di monorepo Nx (modul, dependensi, event).
- Desain Next.js frontend (routing, state, data fetching) & Android client.
- Desain database PostgreSQL (skema, index, partisi, RLS).
- Desain multi-tenancy & isolasi.
- API contract (OpenAPI) untuk modul MVP.
- Audit trail & event processing (outbox).
- Desain integrasi FHIR/SATUSEHAT, lab, payment gateway.
- Backup, recovery, deployment.
- ADR untuk setiap keputusan signifikan.

## 3. Rancangan Pekerjaan

### 3.1 ADR yang Diharapkan

| ADR | Topik |
|---|---|
| ADR-0001 | Stack teknologi (NestJS, Next.js, PostgreSQL, Nx) & batas modul — **Accepted** |
| ADR-0002 | Model multi-tenancy: shared schema + RLS (OD-007) |
| ADR-0003 | Autentikasi: Google OIDC + email/password di NestJS — **Accepted** |
| ADR-0004 | Transactional outbox untuk event & integrasi |
| ADR-0005 | Strategi ID (UUIDv7) & nomor dokumen bisnis |
| ADR-0006 | Immutability rekam medis & mekanisme addendum |
| ADR-0007 | Audit log append-only dengan hash chain |
| ADR-0008 | OpenAPI code-first (`@nestjs/swagger`) & generate client (orval) |
| ADR-0009 | Repository layout (OD-004) |
| ADR-0010 | UI library Next.js (OD-013) |
| ADR-0011 | IaC (OD-006) |
| ADR-0012 | Reporting: read replica vs reporting schema |
| ADR-0013 | Penyimpanan dokumen & signed URL |

### 3.2 Desain Database — Cakupan

- Daftar tabel per modul dengan kolom, tipe, constraint, index.
- Policy RLS untuk setiap tabel tenant.
- Tabel immutable (`clinical_note` signed, `invoice` issued, `payment`, `audit_log`) dilindungi trigger yang menolak `UPDATE/DELETE` setelah status final.
- Partisi untuk tabel besar: `audit_log`, `observation`, `outbox_event` (by bulan).
- Nomor dokumen bisnis (MRN, nomor kunjungan, nomor invoice, nomor resep) via tabel `document_sequence` per tenant/cabang/tahun, bebas celah sesuai kebutuhan.
- Strategi pencarian pasien: `pg_trgm` untuk nama, index untuk NIK (hash) dan MRN.

### 3.3 Contoh Policy RLS

```sql
ALTER TABLE patient ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON patient
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

### 3.4 Pola Outbox

```
[Use case tx] → INSERT domain data + INSERT outbox_event (same tx)
[Worker]      → SELECT ... FOR UPDATE SKIP LOCKED → kirim/proses → tandai SENT
              → gagal: retry backoff → melewati batas: integration_dead_letter
```

## 4. Deliverable

| File | Lokasi |
|---|---|
| SYSTEM_ARCHITECTURE.md | docs/02-architecture/ |
| DATABASE_DESIGN.md | docs/02-architecture/ |
| DATA_DICTIONARY.md | docs/02-architecture/ |
| TENANT_ISOLATION.md | docs/02-architecture/ |
| API_CONTRACTS.md + `openapi.json` hasil generate | docs/02-architecture/, apps/api/ |
| INTEGRATION_ARCHITECTURE.md | docs/02-architecture/ |
| DEPLOYMENT_ARCHITECTURE.md | docs/02-architecture/ |
| ADR/ADR-0001..00NN.md | docs/02-architecture/ADR/ |
| STAGE_COMPLETION_REPORT.md | docs/reports/stage-2/ |

## 5. Gate Checklist

- [ ] Diagram konteks, container, dan komponen (C4) tersedia.
- [ ] Semua tabel MVP terdefinisi dengan RLS & index.
- [ ] OpenAPI modul MVP lolos lint (mis. Spectral).
- [ ] Setiap requirement MVP terpetakan ke modul/API/tabel di RTM.
- [ ] ADR-0001 s.d. ADR-0013 berstatus Accepted (ADR-0001 & ADR-0003 sudah).
- [ ] Strategi backup & DR terdokumentasi dengan target RPO/RTO.
- [ ] Project Owner menyetujui Stage 2.

## 6. Risiko

- Over-engineering pada fase awal → batasi ke kebutuhan MVP + extensibility point.
- Desain RLS memengaruhi performa → buat benchmark kecil sebagai bukti.

## 7. Open Decision

OD-004, OD-006, OD-007, OD-009, OD-013, OD-054 (lihat APP_DESIGN.md). OD-003, OD-005, OD-010 sudah diputuskan.
