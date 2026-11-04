# ADR-0002 — Multi-Tenancy: Shared Schema + PostgreSQL Row-Level Security

| | |
|---|---|
| Status | Accepted — disetujui PO 4 Nov 2026 (DEC-016) |
| Tanggal | 3 November 2026 |
| Menyelesaikan | OD-007 |
| Requirement | GEN-FR-001, NFR-SEC-001, PLT-FR-009 |

## Konteks

ClinicRME melayani banyak tenant dengan skala sangat beragam (praktik mandiri hingga klinik utama multi-cabang). Isolasi data harus kuat, tetapi biaya operasional harus rendah untuk tim kecil.

## Opsi

| Opsi | Isolasi | Biaya operasi | Migrasi skema | Catatan |
|---|---|---|---|---|
| A. Shared schema + `tenant_id` + RLS | Baik (ditegakkan DB) | Rendah | Satu kali | Risiko utama: lupa set context → dimitigasi fail-closed |
| B. Schema per tenant | Lebih baik | Sedang–tinggi | N kali | Sulit untuk ratusan tenant, connection pool per schema |
| C. Database per tenant | Terbaik | Tinggi | N kali | Mahal di Cloud SQL |

## Keputusan

**Opsi A.** Setiap tabel milik tenant memiliki `tenant_id uuid NOT NULL` dan policy RLS:

```sql
ALTER TABLE x ENABLE ROW LEVEL SECURITY;
ALTER TABLE x FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON x
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
```

`app.current_tenant_id()` membaca `current_setting('app.tenant_id', true)`; bila kosong, fungsi mengembalikan NULL sehingga **tidak ada baris yang lolos (fail-closed)**.

### Role database

| Role | Hak | Dipakai oleh |
|---|---|---|
| `clinicrme_owner` | Owner skema, menjalankan migrasi | Pipeline migrasi saja |
| `clinicrme_app` | DML pada tabel tenant (RLS berlaku), tanpa `BYPASSRLS`, tanpa DDL | API & worker |
| `clinicrme_platform` | Akses tabel platform (tenant, paket) tanpa akses tabel klinis | Konsol platform admin |
| `clinicrme_readonly` | SELECT, RLS berlaku | Reporting / read replica |

### Data lintas cabang

Isolasi DB hanya pada level **tenant**. Pembatasan **cabang** dilakukan di lapisan aplikasi (permission + filter `branch_id`), karena pasien dipakai lintas cabang (DEC-013).

### Tabel global

Terminologi (ICD-10, ICD-9-CM, KFA), wilayah administratif, dan daftar permission tidak memiliki `tenant_id`; role aplikasi hanya punya `SELECT`.

## Konsekuensi

- Semua query aplikasi wajib lewat `withTenantTx` (APP_DESIGN §4).
- Test isolasi tenant dijalankan di CI terhadap setiap tabel ber-`tenant_id` (`db/tests/`).
- Tenant enterprise yang membutuhkan isolasi fisik dapat dipindah ke database terpisah di masa depan dengan skema yang sama (ADR baru).
