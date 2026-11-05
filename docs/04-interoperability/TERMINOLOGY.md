# Terminologi & Data Referensi

Deliverable Stage 7 (TRM-FR-001–004, MST-FR-011). Keputusan: DEC-032 (OD-030, OD-031, OD-062, OD-084).

## Prinsip

- **Kode asli tidak diubah.** Setiap code system (ICD-10, ICD-9-CM) disimpan per versi (`code_system`). Versi baru menjadi `is_current`; versi lama tetap tersimpan agar data klinis lama tetap dapat dibaca. Kode yang hilang di versi baru dinonaktifkan, tidak dihapus.
- **Data global, hanya-baca bagi aplikasi.** Tabel `region`, `code_system`, `concept`, dan `reference_dataset` tidak punya `tenant_id`. Role aplikasi hanya punya izin SELECT. Data hanya dimuat oleh role pemilik skema.
- **Sumber & lisensi tercatat.** Setiap dataset dicatat di `db/reference/MANIFEST.json` dan, setelah dimuat, di tabel `reference_dataset`. Catatan itu memuat id, versi, sha256, sumber, lisensi, dan jumlah baris.

## Pemuatan

| Cara | Kapan |
|---|---|
| `pnpm dev:db` | Pengembangan lokal (setelah migrasi) |
| `pnpm db:reference` | Manual, dengan `MIGRATION_DATABASE_URL` role pemilik |
| Job `reference` (image api, `reference.js`) | Setiap deploy VPS, setelah migrasi (`deploy/vps/deploy.sh`) |

Pemuatan bersifat idempoten. Dataset dengan id, versi, dan sha256 yang sama dilewati. Berkas yang sha256-nya tidak cocok dengan MANIFEST ditolak. Setiap dataset dimuat dalam satu transaksi.

## Dataset saat ini

| Id | Versi | Isi | Sumber & lisensi |
|---|---|---|---|
| `region` | `kepmendagri-300.2.2-2138-2025@a985ff7` | 38 provinsi, 514 kab/kota, 7.285 kecamatan, 83.762 kelurahan/desa | `github.com/cahyadsn/wilayah` (MIT), mengikuti Kepmendagri No. 300.2.2-2138 Tahun 2025 |
| `ICD10` | `CONTOH-2026.1` | 40 kode diagnosis umum layanan primer | **CONTOH, bukan data resmi.** Deskripsi Bahasa Indonesia ditulis tim ClinicRME. Kode ICD-10 © WHO |
| `ICD9CM` | `CONTOH-2026.1` | 16 kode tindakan umum | **CONTOH, bukan data resmi** |

## Sebelum pilot (OD-030, RSK-018 masih terbuka)

1. PO mengurus izin resmi data ICD-10 versi Bahasa Indonesia dari WHO dan/atau Kemenkes/SATUSEHAT. Status lisensi ICD-9-CM juga dikonfirmasi. Ini bukan nasihat hukum.
2. Berkas resmi dikonversi ke format CSV pemuat: `code,display_id,display_en,parent_code,synonyms`, dengan sinonim dipisah `|`.
3. Tambahkan entri baru di MANIFEST dengan versi baru (mis. `ICD10` versi `KEMENKES-2010-ID`) beserta sha256, sumber, dan lisensinya, lalu deploy. Versi contoh otomatis menjadi tidak berlaku.
4. Favorit tenant merujuk konsep per versi. Setelah ganti versi, favorit perlu ditandai ulang dan divalidasi dokter.

## Favorit & validasi (TRM-FR-003, OD-084)

- Semua user berizin `terminology.favorite.manage` dapat menandai favorit.
- Validasi hanya dapat dilakukan user yang akunnya tertaut ke tenaga kesehatan aktif berjenis DOKTER, DOKTER_GIGI, atau DOKTER_SPESIALIS dengan SIP yang masih berlaku.
- Kalau spesialisasi favorit diubah tanpa validasi ulang, statusnya kembali menjadi belum divalidasi.
- Pilihan cepat di rekam medis (Stage 9) hanya memakai favorit yang sudah tervalidasi (`favorites=validated`).
- Semua perubahan favorit diaudit.

## KFA (OD-031)

`code_system.code` sudah menerima `KFA`. Sinkronisasi KFA SATUSEHAT dikerjakan di Stage 10/12 setelah akun sandbox SATUSEHAT tersedia (OD-058).
