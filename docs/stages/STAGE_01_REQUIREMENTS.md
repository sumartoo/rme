# Stage 1 — Requirements & Business Analysis

| | |
|---|---|
| Phase | A — Inisiasi & Desain |
| Status | **Selesai — disetujui 3 Nov 2026** |
| Prasyarat | Stage 0 disetujui |
| Stage berikutnya | Stage 2 — Arsitektur |

## 1. Tujuan

Mendokumentasikan seluruh kebutuhan bisnis dan klinis secara lengkap, terukur, dan dapat ditelusuri hingga test case.

## 2. Ruang Lingkup

- Software Requirements Specification (SRS) untuk seluruh modul.
- Use case per aktor.
- Workflow: pendaftaran, klinis, farmasi, pembayaran, administrasi.
- Workflow pasien umum, asuransi, dan tanggungan perusahaan.
- Workflow obat resep dan obat bebas (OTC tanpa kunjungan).
- Workflow pembatalan, refund, rekonsiliasi.
- Kebutuhan integrasi lab & SATUSEHAT.
- Kebutuhan aplikasi Android pasien.
- Klasifikasi **MVP** vs **lanjutan** (tanpa membuang requirement).
- Target NFR (performa, ketersediaan, RPO/RTO).

## 3. Rancangan Pekerjaan

### 3.1 Workflow Utama yang Wajib Dipetakan

| ID | Workflow | Aktor |
|---|---|---|
| WF-01 | Pasien baru walk-in → pemeriksaan → resep → bayar → pulang | Pendaftaran, Perawat, Dokter, Farmasi, Kasir |
| WF-02 | Pasien lama dengan appointment online | Pasien, Pendaftaran, Dokter |
| WF-03 | Pasien asuransi (verifikasi eligibilitas, plafon, co-pay) | Pendaftaran, Kasir |
| WF-04 | Pasien tanggungan perusahaan (kontrak, tagihan kolektif) | Pendaftaran, Kasir, Admin |
| WF-05 | Pembelian obat bebas tanpa kunjungan | Farmasi, Kasir |
| WF-06 | Resep parsial & substitusi obat | Dokter, Farmasi |
| WF-07 | Order lab ke aplikasi lab eksisting & terima hasil | Dokter, Lab |
| WF-08 | Pembatalan kunjungan / invoice / pembayaran | Kasir, Admin |
| WF-09 | Refund & reversal | Kasir, Manajer |
| WF-10 | Closing kasir & rekonsiliasi shift | Kasir, Manajer |
| WF-11 | Koreksi rekam medis yang sudah disahkan (addendum) | Dokter |
| WF-12 | Rujukan keluar | Dokter |
| WF-13 | Pengiriman data ke SATUSEHAT | Sistem |
| WF-14 | Onboarding tenant baru | Platform Admin, Tenant Admin |
| WF-15 | Pasien mengakses riwayat via Android | Pasien, Wali |

Setiap workflow digambarkan dengan BPMN/diagram aktivitas (Mermaid) dan mencatat state transition, exception, dan audit point.

### 3.2 Template Requirement

```markdown
### REG-FR-001 — Registrasi pasien baru
- Prioritas: MVP | Lanjutan
- Aktor: Petugas Pendaftaran
- Deskripsi: ...
- Aturan bisnis: ...
- Data wajib: ...
- Acceptance criteria: AC-REG-FR-001-1, -2, ...
- Sumber: wawancara / regulasi / Project Owner
- Status: Draft | Disetujui
```

### 3.3 Usulan Kelompok MVP (untuk dikonfirmasi)

| MVP (rilis pilot) | Lanjutan |
|---|---|
| Tenant, user, role, menu dinamis | Delegasi akses, jadwal login berbasis shift |
| Master data inti, ICD-10, ICD-9-CM | Versioning master data lanjutan |
| Registrasi, appointment, antrean | Pendaftaran online mandiri via Android |
| SOAP, vital, diagnosis, tindakan, resep, pengesahan, addendum | Template klinis spesialistik lengkap |
| Farmasi: stok batch, dispensing, FEFO | Stock opname lanjutan, multi-gudang |
| Billing: cash, debit, QRIS, refund | Deposit, piutang perusahaan, kontrak asuransi kompleks |
| SATUSEHAT resource wajib | Resource tambahan |
| Laporan standar | Report builder penuh, penjadwalan laporan |
| — | Aplikasi Android pasien |

## 4. Deliverable

| File | Lokasi |
|---|---|
| SRS.md | docs/01-requirements/ |
| USE_CASES.md | docs/01-requirements/ |
| WORKFLOWS.md | docs/01-requirements/ |
| ACCEPTANCE_CRITERIA.md | docs/01-requirements/ |
| REQUIREMENT_TRACEABILITY_MATRIX.md | docs/01-requirements/ |
| NFR.md | docs/01-requirements/ (atau bagian SRS) |
| GLOSSARY.md | docs/01-requirements/ |
| STAGE_COMPLETION_REPORT.md | docs/reports/stage-1/ |

## 5. Gate Checklist

- [ ] Semua workflow WF-01 s.d. WF-15 terdokumentasi & disetujui.
- [ ] Setiap requirement memiliki ID, prioritas, dan acceptance criteria.
- [ ] RTM berisi semua requirement (kolom test case masih kosong).
- [ ] Workflow klinis direview clinical advisor.
- [ ] NFR memiliki angka target (OD-015, OD-016 diputuskan).
- [ ] Pembagian MVP/lanjutan disetujui.
- [ ] Project Owner menyetujui Stage 1.

## 6. Risiko

- Requirement klinis tidak lengkap karena keterbatasan akses tenaga medis.
- Variasi alur antar klinik → kebutuhan konfigurasi tinggi.

## 7. Open Decision

- **OD-008** — Urutan farmasi ↔ kasir konfigurabel?
- **OD-015 / OD-016** — Target SLA & RPO/RTO.
- **OD-021** — Format nomor rekam medis (per tenant / per cabang, prefix).
- **OD-022** — Apakah satu pasien dapat dibagikan antar cabang dalam satu tenant? (usulan: ya)
