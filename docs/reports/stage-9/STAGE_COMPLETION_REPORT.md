# Stage 9 — Stage Completion Report

| | |
|---|---|
| Stage | 9 — Clinical Workflow & Rekam Medis |
| Status | **MENUNGGU REVIEW MEDIS & PERSETUJUAN PO** |
| Disusun oleh | Sumarto (dibantu Claude) |
| Rincian | [STAGE_PLAN.md](STAGE_PLAN.md) §6 · keputusan DEC-038 · paket review [CLINICAL_SAFETY_REVIEW.md](CLINICAL_SAFETY_REVIEW.md) |
| Repo kerja | `sumartoo/rme`, sementara (akses sesi ke `AtoAIs/atoai-rme-v2` terputus 6 Nov). CI GitHub Actions hijau dan deploy otomatis ke VPS dev untuk setiap batch |
| Lingkungan uji | `https://demo.medika.atoai.id` (data sintetis) |

## 1. Ringkasan

Alur rekam medis rawat jalan kini lengkap, dari pasien hadir sampai diteruskan ke farmasi atau kasir:
1. Perawat mencatat tanda vital, alergi, riwayat, dan keluhan awal.
2. Dokter mengisi SOAP dengan template per spesialisasi, lalu diagnosis ICD-10 dan tindakan.
3. Dokter menulis resep (racikan maupun non-racikan) dengan peringatan alergi, duplikasi, dan dosis, serta membuat order lab.
4. Dokter mengesahkan rekam medis dengan konfirmasi ulang. Setelah itu catatan terkunci, ber-hash, dan hanya dapat dikoreksi lewat addendum.
5. Dokter menerbitkan resume, surat sakit/sehat, dan rujukan dalam bentuk PDF, membuat jadwal kontrol, lalu menyelesaikan konsultasi.

| Metrik | Nilai |
|---|---|
| Uji integrasi API | 213/213 (C01–C30 baru) |
| Uji keamanan SQL | 88 PASS + uji migrasi |
| E2E browser | 35/35 (W22–W25 baru) |
| Uji mutasi baru | M39–M59, semua terdeteksi lokal |
| Migrasi | 0019–0022 |
| Kontrak API | 219 operasi |
| Modul baru | `libs/clinical`; master obat di `libs/masterdata` |
| Dependency baru | `pdfmake` (MIT, OD-093) |

## 2. Requirement MVP

| ID | Status | Bukti |
|---|---|---|
| CLN-FR-001 worklist | ✅ perawat/dokter, "pasien saya" | C01, C09, W22 |
| CLN-FR-002 tanda vital + IMT | ✅ batas salah ketik `[REVIEW-MEDIS]` | C02, W22 |
| CLN-FR-004/005 SOAP + template | ✅ Umum/Gigi/Anak/Kebidanan (OD-035), perawat hanya S (OD-092) | C03, C04, W22 |
| CLN-FR-006 alergi di header | ✅ | C07, W22 |
| CLN-FR-007 riwayat penyakit & obat rutin | ✅ | C07 |
| CLN-FR-008 diagnosis ICD-10 | ✅ maks. satu primer | C05, W22 |
| CLN-FR-009 tindakan ICD-9-CM | ✅ layanan + pelaksana. Penagihan dari tindakan dikerjakan di Stage 11 | C06, W22 |
| CLN-FR-010/011 resep non-racikan & racikan | ✅ | C22, W24 |
| CLN-FR-012 peringatan alergi & duplikasi | ✅ + batas dosis (OD-033) | C23–C25, W24 |
| CLN-FR-014 order lab | ✅ konektor tiruan (OD-059) | C26 |
| CLN-FR-015 hasil lab, input manual / PDF | ✅ | C27, C28 |
| CLN-FR-016 riwayat kunjungan | ✅ panel + riwayat rekam medis | C08, C19, W23 |
| CLN-FR-017/018 pengesahan & kelengkapan | ✅ konfirmasi ulang, SIP, hash (OD-034) | C11–C15, W23 |
| CLN-FR-019 addendum | ✅ | C16, C17, W23 |
| CLN-FR-020 resume medis PDF | ✅ | C29, W25 |
| CLN-FR-021 surat sehat & sakit | ✅ | C29, W25 |
| CLN-FR-022 surat rujukan | ✅ | C30 |
| CLN-FR-023 jadwal kontrol | ✅ dari layar encounter, memakai aturan pemesanan janji temu. Endpoint khusus `followUpCreate` tidak dibuat | UI |

## 3. Checklist Gate

- [ ] **Workflow klinis divalidasi tenaga medis** (DEC-005, OD-095). Paket review sudah siap, reviewer belum ditunjuk.
- [x] Catatan SIGNED tidak dapat diubah, baik lewat API maupun lewat SQL role aplikasi (C10, C12, uji SQL T08; mutasi M39)
- [x] Addendum dan hash integritas teruji, termasuk deteksi perubahan di luar aplikasi (C16, C17; M47, M48)
- [x] Audit akses baca rekam medis berfungsi (C08, C19, C28, C29; M40, M59)
- [x] Order dan hasil lab teruji dengan vendor tiruan (C26–C28)
- [x] Matriks permission X01 mencakup semua endpoint baru
- [ ] Uji mutasi lengkap M1–M59 dijalankan di GitHub Actions (manual, `workflow_dispatch`) sebelum persetujuan
- [ ] PO menyetujui Stage 9

## 4. Keamanan & privasi

- Pembukaan layar encounter, riwayat rekam medis, PDF dokumen, dan PDF hasil lab semuanya tercatat di audit dengan `patient_id`. Audit perubahan catatan, diagnosis, dan resep tidak menyalin isi klinis maupun nama obat.
- Pengesahan dan addendum memakai konfirmasi ulang kata sandi atau TOTP (dengan anti-replay). Percobaan yang gagal dibatasi 5 kali per 15 menit.
- Data yang dicabut hak hapus/ubahnya untuk role aplikasi: catatan, observasi, alergi, riwayat, obat, resep, hasil lab, dokumen, berkas, dan rujukan. Trigger database menjaga rekam medis yang sudah disahkan, resep yang sudah terbit (termasuk komponen racikan), dan addendum.
- PDF dibuat di server tanpa akses jaringan atau berkas lokal (hanya font standar). Unggahan hasil lab diperiksa isinya (harus PDF) dan disimpan dengan sha256.
- Tanda tangan elektronik **tidak tersertifikasi**. Kekuatan hukumnya belum diverifikasi (REG-13) dan ini bukan nasihat hukum.

## 5. Catatan untuk Stage berikutnya

- **Stage 10:** layar farmasi (telaah resep, penyerahan, substitusi), stok, harga obat, dan KFA.
- **Stage 11:** tagihan dari tindakan, konsultasi, resep, dan lab.
- **Sebelum pilot:**
  - data ICD resmi (S7-1);
  - adapter vendor lab klinik pilot;
  - hasil review medis (template, batas, teks surat).
- **Batas bulan pada nomor surat.** Bagian `{YYYY}/{MM}` diisi dari jam server (UTC), sedangkan urutan dihitung per bulan zona waktu cabang. Akibatnya, surat yang terbit antara 00.00 dan 07.00 WIB pada tanggal 1 bisa memakai bulan sebelumnya. Akan disesuaikan bersama pola nomor yang bisa diatur klinik.

## 6. Persetujuan

| Peran | Nama | Keputusan | Tanggal | Catatan |
|---|---|---|---|---|
| Reviewer medis | | ☐ Layak ☐ Perlu perubahan | | |
| Project Owner | Sumarto | ☐ Disetujui ☐ Revisi | | |
