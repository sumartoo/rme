# Stage 5 — SaaS Administration & Tenant Management

| | |
|---|---|
| Phase | C — Platform SaaS |
| Status | **Disetujui dengan catatan** 4 Nov 2026 (DEC-028) |
| Prasyarat | Stage 4 disetujui |
| Modul | `platform` |

## 1. Tujuan

Mengelola fasilitas kesehatan sebagai pelanggan SaaS: onboarding, langganan, kuota, status, dan offboarding.

## 2. Ruang Lingkup

- Onboarding & registrasi tenant.
- Profil klinik, cabang, fasilitas (data minimum; detail master di Stage 7).
- Paket langganan, trial, masa aktif, jatuh tempo.
- Batas pengguna, cabang, kapasitas.
- Domain/subdomain & branding (logo, warna, kop surat).
- Status aktif, grace period, suspend, reaktivasi, terminasi.
- Ekspor data saat berhenti berlangganan.
- Pemisahan konsol platform dari aplikasi klinik.
- Pembatasan akses superadmin terhadap data klinis.

## 3. Rancangan

### 3.1 Tabel Inti

| Tabel | Kolom penting |
|---|---|
| `tenant` | id, code, legal_name, type (UTAMA/PRATAMA/MANDIRI), status, subdomain, timezone |
| `subscription_plan` | id, code, name, max_users, max_branches, features (jsonb), price |
| `tenant_subscription` | tenant_id, plan_id, start_at, end_at, trial_end_at, status |
| `tenant_branding` | tenant_id, logo_object, primary_color, letterhead |
| `tenant_feature_flag` | tenant_id, feature_code, enabled |
| `tenant_status_history` | tenant_id, from, to, reason, actor, at |
| `tenant_export_job` | tenant_id, status, object_path, expires_at |

### 3.2 State Tenant

```
PROVISIONING → TRIAL → ACTIVE → GRACE → SUSPENDED → TERMINATED
                           ↑__________|  (reaktivasi)
```

- **SUSPENDED:** login staf diblokir kecuali tenant admin (untuk pembayaran/ekspor); data tetap tersimpan.
- **TERMINATED:** data diekspor & diserahkan, lalu ditangani sesuai kebijakan retensi (tidak langsung dihapus — rekam medis tunduk pada kewajiban retensi).

### 3.3 Enforcement Kuota

Pengecekan di use case (bukan hanya UI): menambah user/cabang melebihi paket → error `PLT-403-QUOTA`.

### 3.4 Layar

- Platform Admin: daftar tenant, detail, paket, status, histori, ekspor.
- Tenant Admin: profil klinik, branding, info langganan.

## 4. Requirement Awal

| ID | Ringkasan |
|---|---|
| PLT-FR-001 | Platform admin membuat tenant dan tenant admin pertama |
| PLT-FR-002 | Tenant memiliki paket dan masa aktif |
| PLT-FR-003 | Sistem menegakkan kuota user & cabang |
| PLT-FR-004 | Perubahan status tenant tercatat dan teraudit |
| PLT-FR-005 | Tenant dapat meminta ekspor data lengkap |
| PLT-FR-006 | Superadmin tidak dapat membuka data klinis tanpa break-glass |

## 5. Deliverable

Kode modul `platform`, migrasi, OpenAPI `/api/platform/v1`, layar platform admin, test, `docs/reports/stage-5/STAGE_COMPLETION_REPORT.md`.

## 6. Gate Checklist

- [ ] Siklus status tenant teruji lengkap.
- [ ] Kuota ditegakkan di backend.
- [ ] Test: superadmin tidak dapat mengakses endpoint klinis.
- [ ] Test isolasi lintas tenant pada seluruh endpoint baru.
- [ ] Ekspor tenant menghasilkan arsip lengkap & terenkripsi.
- [ ] Project Owner menyetujui Stage 5.

## 7. Open Decision

- **OD-027** — Billing langganan SaaS otomatis (payment gateway) atau manual invoice di tahap awal?
- **OD-028** — Format ekspor data tenant (FHIR Bundle, CSV, keduanya).
