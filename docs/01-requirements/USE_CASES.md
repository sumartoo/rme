# Use Cases — ClinicRME SaaS

| | |
|---|---|
| Versi | 1.0 — Disetujui (DEC-015) |
| Tanggal | 3 November 2026 |
| Stage | 1 |

## 1. Aktor

| Aktor | Deskripsi |
|---|---|
| Platform Admin | Pengelola platform ClinicRME (tanpa akses data klinis) |
| Tenant Admin | Administrator klinik |
| Pendaftaran | Petugas registrasi & antrean |
| Perawat | Perawat / bidan |
| Dokter | Dokter / dokter gigi penanggung jawab pelayanan |
| Farmasi | Apoteker / tenaga teknis kefarmasian |
| Kasir | Petugas pembayaran |
| Manajer | Pemilik / manajer klinik |
| Auditor | Pemeriksa audit (read-only) |
| Sistem | Proses otomatis (worker, job terjadwal) |
| SATUSEHAT / Lab / Payment Gateway | Sistem eksternal |

## 2. Indeks Use Case

| UC ID | Nama | Aktor utama | Requirement | Prioritas |
|---|---|---|---|---|
| UC-PLT-01 | Membuat tenant baru | Platform Admin | PLT-FR-001, PLT-FR-002, PLT-FR-003, PLT-FR-011 | MVP |
| UC-PLT-02 | Mengubah status tenant | Platform Admin | PLT-FR-005, PLT-FR-006, PLT-FR-013 | MVP |
| UC-PLT-03 | Mengatur profil & branding klinik | Tenant Admin | PLT-FR-007, DOC-FR-001 | MVP |
| UC-PLT-04 | Mengekspor data tenant | Tenant Admin | PLT-FR-008 | MVP |
| UC-PLT-05 | Akses dukungan break-glass | Platform Admin | PLT-FR-009, AUD-FR-001 | MVP |
| UC-IAM-01 | Mengundang user | Tenant Admin | IAM-FR-001, IAM-FR-009, IAM-FR-016, PLT-FR-004, NTF-FR-001 | MVP |
| UC-IAM-02 | Login dengan Google | Semua staf | IAM-FR-002, IAM-FR-005, IAM-FR-009 | MVP |
| UC-IAM-03 | Login dengan email & password | Semua staf | IAM-FR-003, IAM-FR-005 | MVP |
| UC-IAM-04 | Reset password | Semua staf | IAM-FR-004, NTF-FR-001 | MVP |
| UC-IAM-05 | Mengelola role & permission | Tenant Admin | IAM-FR-007, IAM-FR-008, IAM-FR-010, IAM-FR-011 | MVP |
| UC-IAM-06 | Mengelola sesi & menonaktifkan user | Tenant Admin, staf | IAM-FR-013, IAM-FR-014 | MVP |
| UC-AUD-01 | Menelusuri audit log | Auditor, Tenant Admin | AUD-FR-001, AUD-FR-002, AUD-FR-003, AUD-FR-004 | MVP |
| UC-MST-01 | Mengelola fasilitas, cabang, unit | Tenant Admin | MST-FR-001, MST-FR-009 | MVP |
| UC-MST-02 | Mengelola tenaga kesehatan | Tenant Admin | MST-FR-002, MST-FR-009 | MVP |
| UC-MST-03 | Mengelola layanan & tarif | Tenant Admin | MST-FR-004, MST-FR-005, MST-FR-009 | MVP |
| UC-MST-04 | Mengelola penjamin | Tenant Admin | MST-FR-006, BPJ-FR-004 | MVP |
| UC-MST-05 | Impor/ekspor master data | Tenant Admin | MST-FR-007, MST-FR-008, MST-FR-010, MST-FR-011 | MVP |
| UC-TRM-01 | Mengelola diagnosis & tindakan favorit | Tenant Admin, Dokter | TRM-FR-001, TRM-FR-002, TRM-FR-003, TRM-FR-004 | MVP |
| UC-REG-01 | Mendaftarkan pasien baru | Pendaftaran | REG-FR-001, REG-FR-002, REG-FR-004, REG-FR-006, REG-FR-007, REG-FR-008, REG-FR-009, REG-FR-011 | MVP |
| UC-REG-02 | Mencari pasien | Pendaftaran | REG-FR-003, REG-FR-012 | MVP |
| UC-REG-03 | Menggabungkan pasien duplikat | Tenant Admin | REG-FR-005 | MVP |
| UC-SCH-01 | Mengatur jadwal praktik | Tenant Admin | SCH-FR-001, SCH-FR-002 | MVP |
| UC-SCH-02 | Membuat & mengubah appointment | Pendaftaran | SCH-FR-003, SCH-FR-010 | MVP |
| UC-SCH-03 | Check-in / walk-in & antrean | Pendaftaran | SCH-FR-005, SCH-FR-006, SCH-FR-007, SCH-FR-013 | MVP |
| UC-SCH-04 | Memanggil antrean & layar TV | Perawat, Dokter | SCH-FR-008 | MVP |
| UC-SCH-05 | Menandai no-show otomatis | Sistem | SCH-FR-011 | MVP |
| UC-CLN-01 | Triase & tanda vital | Perawat | CLN-FR-002, CLN-FR-006, CLN-FR-007 | MVP |
| UC-CLN-02 | Pemeriksaan dokter (SOAP, diagnosis, tindakan) | Dokter | CLN-FR-001, CLN-FR-004, CLN-FR-005, CLN-FR-008, CLN-FR-009, CLN-FR-016, AUD-FR-002 | MVP |
| UC-CLN-03 | Menulis resep elektronik | Dokter | CLN-FR-010, CLN-FR-011, CLN-FR-012, TRM-FR-005 | MVP |
| UC-CLN-04 | Order & melihat hasil lab | Dokter | CLN-FR-014, CLN-FR-015, DOC-FR-003 | MVP |
| UC-CLN-05 | Mengesahkan rekam medis | Dokter | CLN-FR-017, CLN-FR-018 | MVP |
| UC-CLN-06 | Membuat addendum | Dokter | CLN-FR-019, INT-FR-012 | MVP |
| UC-CLN-07 | Membuat dokumen medis & rujukan | Dokter | CLN-FR-020, CLN-FR-021, CLN-FR-022, DOC-FR-001, DOC-FR-002 | MVP |
| UC-CLN-08 | Menjadwalkan kontrol | Dokter | CLN-FR-023 | MVP |
| UC-PHM-01 | Menerima barang | Farmasi | PHM-FR-001, PHM-FR-002, PHM-FR-003, PHM-FR-004 | MVP |
| UC-PHM-02 | Telaah & dispensing resep | Farmasi | PHM-FR-005, PHM-FR-006, PHM-FR-007, PHM-FR-008, PHM-FR-011, PHM-FR-013, PHM-FR-019 | MVP |
| UC-PHM-03 | Resep parsial & substitusi | Farmasi, Dokter | PHM-FR-009, PHM-FR-010 | MVP |
| UC-PHM-04 | Penjualan obat bebas | Farmasi | PHM-FR-012 | MVP |
| UC-PHM-05 | Penyesuaian stok & opname | Farmasi, Manajer | PHM-FR-014, PHM-FR-016, PHM-FR-017 | MVP |
| UC-BIL-01 | Menerbitkan & membayar invoice | Kasir | BIL-FR-001, BIL-FR-002, BIL-FR-003, BIL-FR-004, BIL-FR-005, BIL-FR-007, BIL-FR-008 | MVP |
| UC-BIL-02 | Pembayaran QRIS | Kasir, Payment Gateway | BIL-FR-006, BIL-FR-012 | MVP |
| UC-BIL-03 | Void invoice | Kasir, Manajer | BIL-FR-009 | MVP |
| UC-BIL-04 | Refund | Kasir, Manajer | BIL-FR-010, BIL-FR-016 | MVP |
| UC-BIL-05 | Buka & tutup shift | Kasir | BIL-FR-011 | MVP |
| UC-BIL-06 | Mengelola piutang penjamin | Kasir, Manajer | BIL-FR-013 | MVP |
| UC-INT-01 | Mengatur kredensial SATUSEHAT | Tenant Admin | INT-FR-001, INT-FR-002 | MVP |
| UC-INT-02 | Mengirim data ke SATUSEHAT | Sistem | INT-FR-003, INT-FR-004, INT-FR-005, INT-FR-008, INT-FR-009 | MVP |
| UC-INT-03 | Memantau & merekonsiliasi integrasi | Tenant Admin | INT-FR-010, INT-FR-011 | MVP |
| UC-RPT-01 | Melihat laporan operasional | Manajer | RPT-FR-001, RPT-FR-002, RPT-FR-003, RPT-FR-004, RPT-FR-007, RPT-FR-009 | MVP |
| UC-RPT-02 | Melihat laporan farmasi | Farmasi, Manajer | RPT-FR-005, RPT-FR-006 | MVP |
| UC-RPT-03 | Mengekspor laporan | Manajer | RPT-FR-008, BIL-FR-016 | MVP |

Use case untuk requirement Lanjutan (POR, BPJ, RPT-FR-010, dll.) disusun ketika requirement tersebut dijadwalkan.

---

## 3. Use Case Rinci

### UC-IAM-02 — Login dengan Google

| | |
|---|---|
| Aktor | Staf klinik |
| Prasyarat | User telah diundang (UC-IAM-01) atau akun Google sudah tertaut |
| Pemicu | User klik "Masuk dengan Google" |

**Alur utama**
1. Sistem mengarahkan user ke Google.
2. User memilih akun Google dan menyetujui.
3. Sistem memverifikasi token Google.
4. Sistem menemukan user yang tertaut dengan akun Google tersebut.
5. Sistem memeriksa status user & tenant aktif.
6. Jika user ditugaskan ke lebih dari satu cabang, user memilih cabang aktif.
7. Jika role user mewajibkan MFA, user memasukkan kode TOTP.
8. Sistem membuat sesi dan menampilkan dashboard sesuai permission.

**Alur alternatif**
- 4a. Akun Google belum tertaut tetapi ada undangan aktif untuk email yang sama → sistem menautkan, menandai undangan diterima, lanjut ke langkah 5.
- 4b. Tidak ada tautan maupun undangan → login ditolak dengan pesan "Akun belum terdaftar di klinik. Hubungi admin klinik."
- 5a. User nonaktif atau tenant Suspended (bukan tenant admin) → login ditolak.
- 7a. Kode MFA salah 5× → login dikunci sementara.

**Pascakondisi:** sesi aktif tercatat; audit log `LOGIN`.

---

### UC-REG-01 — Mendaftarkan Pasien Baru `[REVIEW-MEDIS]`

| | |
|---|---|
| Aktor | Pendaftaran |
| Prasyarat | User login di cabang aktif |
| Pemicu | Pasien datang dan tidak ditemukan pada pencarian |

**Alur utama**
1. Petugas memasukkan data identitas (nama, tanggal lahir, jenis kelamin, NIK, alamat, telepon).
2. Sistem mencari kandidat duplikat secara otomatis.
3. Tidak ada kandidat → petugas mengisi kontak darurat, penjamin, dan mencatat consent umum.
4. Petugas menyimpan; sistem membuat MRN.
5. Sistem menjalankan lookup IHS SATUSEHAT berdasarkan NIK di latar belakang.
6. Sistem menampilkan pilihan membuat kunjungan.

**Alur alternatif**
- 1a. Pasien tanpa NIK → petugas memilih jenis identitas alternatif; lookup IHS dilewati dan pasien ditandai "IHS belum ada".
- 2a. Ada kandidat duplikat → sistem menampilkan daftar; petugas memilih pasien lama (selesai) atau melanjutkan dengan alasan.
- 5a. Lookup IHS gagal → ditandai untuk dicoba ulang; registrasi tetap tersimpan.

**Pascakondisi:** pasien tersimpan, NIK terenkripsi, audit `CREATE patient`.

---

### UC-CLN-02 — Pemeriksaan Dokter `[REVIEW-MEDIS]`

| | |
|---|---|
| Aktor | Dokter |
| Prasyarat | Kunjungan berstatus TRIAGED atau ARRIVED untuk dokter ini |

**Alur utama**
1. Dokter membuka worklist dan memanggil pasien.
2. Sistem menampilkan layar encounter dengan header pasien (umur, penjamin, alergi) dan riwayat kunjungan; akses dicatat di audit.
3. Dokter memilih template sesuai poli, mengisi SOAP.
4. Dokter menambahkan diagnosis ICD-10 (primer & sekunder) dan tindakan ICD-9-CM.
5. Dokter menulis resep (UC-CLN-03) dan/atau order lab (UC-CLN-04) bila perlu.
6. Dokter menyimpan draft secara berkala (otomatis).
7. Dokter melanjutkan ke pengesahan (UC-CLN-05).

**Alur alternatif**
- 2a. Pasien memiliki alergi → banner merah di header.
- 3a. Dokter lain sedang membuka encounter yang sama → sistem memperingatkan; simpan dengan versi lama ditolak.

**Pascakondisi:** catatan klinis berstatus DRAFT; tindakan masuk draft tagihan.

---

### UC-CLN-05 — Mengesahkan Rekam Medis `[REVIEW-MEDIS]`

**Alur utama**
1. Dokter klik "Sahkan".
2. Sistem memvalidasi: SOAP terisi, diagnosis primer ada, resep valid.
3. Sistem menampilkan ringkasan untuk konfirmasi.
4. Dokter mengonfirmasi (dengan re-autentikasi bila dikonfigurasi).
5. Sistem mengunci catatan (status SIGNED), menghitung hash isi, mencatat penandatangan & waktu.
6. Sistem menerbitkan event: resep → worklist farmasi, data → antrean SATUSEHAT, kunjungan → CONSULT_DONE.

**Alternatif:** 2a. Validasi gagal → daftar kekurangan ditampilkan; tidak ada perubahan status.

**Pascakondisi:** catatan immutable; koreksi hanya via UC-CLN-06.

---

### UC-PHM-02 — Telaah & Dispensing Resep

**Alur utama**
1. Farmasi membuka worklist resep cabang.
2. Memilih resep → sistem menampilkan item, alergi pasien, stok tersedia.
3. Farmasi mengisi checklist telaah (administratif, farmasetik, klinis) → VERIFIED.
4. Sistem mengusulkan batch per item (FEFO); farmasi dapat mengganti batch yang valid.
5. Farmasi mencetak etiket, menyiapkan obat, menyerahkan dengan edukasi.
6. Sistem mengurangi stok (ledger), menandai resep DISPENSED, menambah baris obat ke invoice.

**Alternatif**
- 4a. Stok kurang → resep parsial (UC-PHM-03).
- 4b. Batch kedaluwarsa / stok tidak cukup → tidak dapat dipilih.
- 3a. Obat narkotika/psikotropika → hanya user dengan permission khusus.

---

### UC-BIL-01 — Menerbitkan & Membayar Invoice

**Alur utama**
1. Kasir membuka daftar kunjungan berstatus BILLING.
2. Sistem menampilkan draft invoice: konsultasi, tindakan, obat, lab, dengan harga snapshot dan pembagian penjamin/pasien.
3. Kasir menerapkan diskon (bila ada, sesuai batas).
4. Kasir menerbitkan invoice (ISSUED, bernomor).
5. Pasien membayar dengan satu atau beberapa metode.
6. Sistem mencatat pembayaran di shift aktif, mencetak kwitansi, menandai kunjungan FINISHED bila lunas.

**Alternatif**
- 3a. Diskon melebihi batas → butuh persetujuan manajer.
- 5a. QRIS → UC-BIL-02.
- 5b. Pembayaran sebagian → status PARTIALLY_PAID; sisa tercatat.
- 2a. Porsi penjamin → tercatat sebagai piutang (UC-BIL-06).

---

### UC-BIL-02 — Pembayaran QRIS

1. Kasir memilih QRIS untuk nominal tertentu.
2. Sistem meminta QR dinamis ke payment gateway (dengan idempotency key) dan menampilkannya.
3. Pasien memindai & membayar.
4. Gateway mengirim callback → sistem memverifikasi signature, nominal, status, dan idempotency.
5. Pembayaran tercatat; layar kasir diperbarui otomatis.

**Alternatif:** 4a. Callback tidak valid → diabaikan & dicatat. 4b. Callback tidak datang dalam batas waktu → sistem menanyakan status ke gateway; QR kedaluwarsa dibatalkan.

---

### UC-INT-02 — Mengirim Data ke SATUSEHAT

1. Sistem menerima event (registrasi, pengesahan, dispensing).
2. Worker menyusun resource FHIR sesuai urutan dependensi.
3. Validasi payload; kirim dengan token fasilitas.
4. Simpan ID SATUSEHAT & status terkirim.

**Alternatif:** 3a. Validasi gagal → status ERROR dengan pesan, tampil di dashboard. 3b. Gagal jaringan / 5xx → retry backoff; melewati batas → dead-letter + notifikasi admin.
