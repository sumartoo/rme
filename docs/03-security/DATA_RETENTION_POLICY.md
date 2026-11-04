# Data Retention Policy — ClinicRME SaaS

| | |
|---|---|
| Versi | 0.1 — DRAFT (Stage 3) |
| Tanggal | 4 November 2026 |
| Requirement | NFR-RET-001, NFR-AUD-002, PLT-FR-013 |
| Menyelesaikan | OD-023 (diputuskan, DEC-019) |

> Bukan nasihat hukum; masa simpan diverifikasi konsultan hukum sebelum produksi.

## 1. Jadwal Retensi

| Kategori data | Tabel utama | Masa simpan minimum | Dasar | Setelah masa simpan |
|---|---|---|---|---|
| Rekam medis elektronik | `clinical_note`, `clinical_addendum`, `observation`, `condition_dx`, `procedure_act`, `prescription*`, `lab_*`, `medical_document`, `referral`, `allergy_intolerance`, `patient_history` | **25 tahun sejak kunjungan terakhir pasien** | Permenkes 24/2022 (retensi RME) | Ditinjau klinik: dimusnahkan dengan berita acara, atau dipertahankan bila masih digunakan |
| Identitas pasien | `patient`, `patient_identifier`, `patient_contact`, `patient_coverage`, `patient_consent` | Mengikuti rekam medis pasien | Bagian dari rekam medis | Idem |
| Audit akses & perubahan RM | `audit_log` (dengan `patient_id`) | Mengikuti rekam medis | Bukti akses & integritas RM | Idem |
| Dokumen & transaksi keuangan | `invoice*`, `payment`, `refund`, `receivable`, `cashier_shift`, `payment_gateway_txn` | **10 tahun sejak akhir tahun buku** | UU 28/2007 (KUP) Pasal 28 ayat (11); UU 8/1997 Pasal 11 | Dapat dimusnahkan oleh klinik |
| Stok & farmasi (termasuk narkotika/psikotropika) | `stock_movement`, `goods_receipt*`, `dispense*`, `otc_sale*`, `stock_opname*` | 10 tahun (bukti pembukuan); ketentuan khusus pelaporan narkotika/psikotropika diverifikasi (REG-10) | UU 8/1997; ketentuan kefarmasian | Idem |
| Audit login & administrasi | `audit_log` (tanpa `patient_id`) | 2 tahun | Kebutuhan investigasi keamanan | Dihapus otomatis (partisi) |
| Sesi | `user_session` | 90 hari setelah berakhir | Investigasi keamanan | Dihapus otomatis |
| Undangan & token | `user_invitation`, token reset | 30 hari setelah kedaluwarsa/dipakai | — | Dihapus otomatis |
| Outbox & job | `outbox_event`, antrean pg-boss | 30 hari setelah selesai | — | Dihapus otomatis |
| Status sinkronisasi SATUSEHAT | `fhir_sync_record`, `integration_dead_letter` | Mengikuti rekam medis | Bukti pemenuhan kewajiban integrasi | Idem |
| Ekspor sementara | GCS bucket `exports` | 7 hari | — | Lifecycle hapus otomatis |
| Log aplikasi (tanpa PHI) | Cloud Logging | 30 hari (hot); 1 tahun (arsip) | Operasional & keamanan | Dihapus otomatis |
| Backup DB | Cloud SQL | 30 hari (harian) + PITR 7 hari | DR | Rotasi otomatis |
| Data langganan SaaS | `tenant*`, `subscription_*` | Selama kontrak + 10 tahun | Dokumen keuangan ClinicRME | — |

## 2. Prinsip

1. **Tidak ada penghapusan otomatis atas rekam medis.** Pemusnahan rekam medis adalah keputusan klinik (pengendali), dilakukan sesuai prosedur dan didokumentasikan; ClinicRME menyediakan daftar kandidat & fungsi pemusnahan teraudit (Stage 17).
2. Masa 25 tahun dihitung **per pasien** dari kunjungan terakhir; kunjungan baru memperpanjang masa simpan seluruh rekam pasien tersebut.
3. Data yang masa simpannya lebih pendek tetapi terkait rekam medis (mis. invoice kunjungan) tidak dimusnahkan bila masih dibutuhkan sebagai bukti medis-legal.
4. **Legal hold**: klinik atau ClinicRME dapat menandai pasien/tenant dalam sengketa sehingga semua pemusnahan ditangguhkan.

## 3. Tenant Berhenti Berlangganan (PLT-FR-013)

```
ACTIVE → (berhenti) → GRACE (30 hari, akses penuh)
       → SUSPENDED (akses admin untuk ekspor)
       → ekspor lengkap diserahkan ke klinik (PLT-FR-008) + berita acara serah terima
       → TERMINATED
            · data rekam medis TIDAK dihapus otomatis
            · opsi A: klinik memilih "penyimpanan arsip" berbayar sampai masa retensi berakhir (read-only)
            · opsi B: klinik menyatakan tertulis telah menerima & menyimpan sendiri seluruh data
                      → ClinicRME memusnahkan setelah masa tunggu 90 hari, dengan berita acara
```

Pilihan A/B menjadi klausul DPA (OD-060) dan model harga (RSK-011, OD-070).

## 4. Penyimpanan Jangka Panjang

| Tahap | Lokasi | Akses |
|---|---|---|
| Aktif (≤ 2 tahun sejak kunjungan terakhir) | Cloud SQL | Normal |
| Arsip (> 2 tahun) | Tetap di Cloud SQL di MVP; evaluasi pemindahan ke tabel/partisi arsip atau ekspor GCS Archive di Stage 15 berdasarkan volume | Baca saja, teraudit |
| Dokumen PDF | GCS dengan lifecycle Standard → Nearline (1 th) → Coldline (3 th) → Archive (5 th) | Signed URL |

## 5. Pemusnahan

- Dilakukan dengan fungsi khusus berperan owner (bukan role aplikasi), menghasilkan berita acara (daftar pasien, jumlah record, hash) yang disimpan permanen.
- Backup yang memuat data yang dimusnahkan akan habis sesuai rotasi backup (≤ 30 hari); hal ini dicantumkan dalam berita acara.
- Hash chain audit tetap dapat diverifikasi karena entri audit pemusnahan disimpan.

## 6. Open Decision

| ID | Pertanyaan |
|---|---|
| OD-023 | Masa simpan audit — diputuskan sesuai tabel §1 (DEC-019) |
| OD-070 | Model harga & teknis "penyimpanan arsip" setelah tenant berhenti |
| REG-10 | Ketentuan khusus penyimpanan catatan narkotika/psikotropika di klinik |
