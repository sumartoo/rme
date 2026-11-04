# Stage 16 — Integration Testing, UAT & Pilot

| | |
|---|---|
| Phase | F — Produksi |
| Status | Belum dimulai |
| Prasyarat | Stage 15 disetujui |

## 1. Tujuan

Memastikan sistem siap dipakai di klinik nyata melalui pengujian menyeluruh, UAT, dan pilot terkendali.

## 2. Ruang Lingkup

- End-to-end & regression test.
- Tenant isolation test.
- Clinical safety test.
- Payment reconciliation test.
- FHIR/SATUSEHAT integration test.
- Android test.
- Performance & security test (termasuk penetration test independen).
- UAT oleh klinik pilot.
- Migrasi data dengan validasi.
- Pelatihan pengguna.
- SOP operasional & dukungan.
- Go-live checklist.

## 3. Rancangan

### 3.1 Skenario E2E Wajib

| ID | Skenario |
|---|---|
| E2E-01 | Pasien baru walk-in umum: daftar → vital → SOAP → resep → dispensing → bayar tunai → SATUSEHAT |
| E2E-02 | Pasien asuransi dengan split payment |
| E2E-03 | Pasien perusahaan → piutang → pelunasan |
| E2E-04 | Appointment online → no-show |
| E2E-05 | Resep parsial + substitusi |
| E2E-06 | Order lab → hasil → tampil di Android |
| E2E-07 | Koreksi RM via addendum → update SATUSEHAT |
| E2E-08 | Refund QRIS dengan approval → rekonsiliasi |
| E2E-09 | Closing shift dengan selisih |
| E2E-10 | Suspend tenant → akses terblokir → reaktivasi |

### 3.2 Migrasi Data (bila klinik pilot punya sistem lama)

1. Profiling data sumber.
2. Mapping & aturan transformasi.
3. Uji migrasi di staging (data dimasking bila memungkinkan, dengan persetujuan klinik & dasar hukum yang jelas).
4. Validasi: jumlah record, checksum, sampel verifikasi manual oleh klinik.
5. Rencana cut-over & rollback.

### 3.3 Pilot

| Aspek | Usulan |
|---|---|
| Jumlah klinik | 1–2 (sebaiknya beda segmen) |
| Durasi | Ditetapkan Project Owner |
| Mode | Paralel dengan proses lama di awal (OD-050) |
| Dukungan | Pendampingan on-site/remote, kanal tiket |
| Kriteria keluar | Tidak ada defect kritis terbuka, kepuasan pengguna, data terekonsiliasi |

## 4. Deliverable

`TEST_CASES.md` lengkap & RTM terisi kolom test, laporan test per kategori, laporan pentest, `UAT_REPORT.md`, `DATA_MIGRATION_PLAN.md`, materi pelatihan, `SOP_OPERASIONAL.md`, `GO_LIVE_CHECKLIST.md`, completion report.

## 5. Gate Checklist

- [ ] RTM: setiap requirement MVP memiliki test case dengan hasil lulus.
- [ ] Tidak ada defect kritis/tinggi terbuka.
- [ ] Temuan pentest kritis/tinggi ditutup.
- [ ] UAT ditandatangani klinik pilot.
- [ ] Migrasi data tervalidasi.
- [ ] Pengguna pilot terlatih.
- [ ] Project Owner & klinik pilot menyetujui rilis.

## 6. Open Decision

- **OD-050** — Operasi paralel atau cut-over langsung.
- **OD-051** — Vendor pentest independen (biaya perlu persetujuan).
