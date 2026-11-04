# Software Requirements Specification — ClinicRME SaaS

| | |
|---|---|
| Versi | 1.0 — Disetujui (DEC-015) |
| Tanggal | 3 November 2026 |
| Stage | 1 |
| Status | Baseline — perubahan via CR |

**Prioritas:** `MVP` = wajib untuk pilot · `LJT` = Lanjutan (setelah pilot).
**Tag:** `[REVIEW-MEDIS]` = wajib direview tenaga medis · `[OD-xxx]` = bergantung pada open decision.

---

## 1. Pendahuluan

### 1.1 Tujuan Dokumen
Mendefinisikan kebutuhan fungsional ClinicRME SaaS. Kebutuhan non-fungsional di [NFR.md](NFR.md); alur kerja di [WORKFLOWS.md](WORKFLOWS.md).

### 1.2 Ruang Lingkup
Sesuai [SCOPE.md](../00-governance/SCOPE.md) v1.0.

### 1.3 Aturan Umum (berlaku semua modul)

| ID | Aturan |
|---|---|
| GEN-FR-001 | Semua data milik tenant hanya dapat diakses oleh pengguna tenant tersebut. `MVP` |
| GEN-FR-002 | Semua aksi tulis dicatat di audit log (siapa, apa, kapan, dari mana). `MVP` |
| GEN-FR-003 | Data klinis dan transaksi yang telah disahkan tidak dapat dihapus atau diubah; koreksi melalui addendum / void / reversal. `MVP` |
| GEN-FR-004 | Setiap daftar data mendukung pencarian, filter, sortir, dan paginasi. `MVP` |
| GEN-FR-005 | Antarmuka berbahasa Indonesia; format tanggal `dd/MM/yyyy`, mata uang Rupiah, zona waktu cabang. `MVP` |
| GEN-FR-006 | Setiap dokumen bisnis memiliki nomor unik berformat dapat dikonfigurasi per tenant (MRN, kunjungan, resep, invoice). `MVP` |
| GEN-FR-007 | Perubahan bersamaan pada data yang sama terdeteksi (optimistic locking) dan pengguna diberi tahu. `MVP` |

---

## 2. Platform & Tenant (PLT) — Stage 5

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| PLT-FR-001 | Platform admin membuat tenant baru beserta tenant admin pertama (undangan email). | MVP | |
| PLT-FR-002 | Tenant memiliki tipe: Klinik Utama, Klinik Pratama, Praktik Mandiri. | MVP | |
| PLT-FR-003 | Tenant memiliki paket langganan dengan batas user, cabang, dan fitur. | MVP | |
| PLT-FR-004 | Sistem menegakkan kuota paket di backend; penolakan menampilkan pesan yang jelas. | MVP | |
| PLT-FR-005 | Tenant memiliki status: Trial, Aktif, Grace, Suspended, Terminated; setiap perubahan tercatat dengan alasan. | MVP | |
| PLT-FR-006 | Saat Suspended, hanya tenant admin yang dapat login untuk pembayaran/ekspor. | MVP | |
| PLT-FR-007 | Tenant admin mengatur profil klinik: nama, alamat, izin, logo, kop surat. | MVP | |
| PLT-FR-008 | Tenant dapat meminta ekspor seluruh data; hasil berupa arsip terenkripsi dengan tautan berbatas waktu. | MVP | Format OD-028 |
| PLT-FR-009 | Superadmin tidak dapat membuka data klinis tenant; akses dukungan hanya via break-glass berbatas waktu, beralasan, dan teraudit. | MVP | |
| PLT-FR-010 | Subdomain per tenant (`klinikabc.clinicrme.id`). | LJT | |
| PLT-FR-011 | Feature flag per tenant. | MVP | Untuk rilis bertahap |
| PLT-FR-012 | Penagihan langganan otomatis via payment gateway. | LJT | OD-027 |
| PLT-FR-013 | Kebijakan penanganan data tenant Terminated mengikuti kewajiban retensi rekam medis (data tidak langsung dihapus). | MVP | REG-03 |

## 3. Identitas & Akses (IAM) — Stage 3, 6

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| IAM-FR-001 | User hanya dapat dibuat melalui undangan dari tenant admin (email, role, cabang). | MVP | ADR-0003 |
| IAM-FR-002 | Login dengan Google (OIDC); akun Google harus cocok dengan undangan aktif saat penautan pertama. | MVP | |
| IAM-FR-003 | Login dengan email + password; kebijakan password minimum & lockout setelah N kali gagal. | MVP | |
| IAM-FR-004 | Reset password via tautan email bertoken berbatas waktu. | MVP | |
| IAM-FR-005 | MFA TOTP wajib untuk role admin tenant & platform; opsional per tenant untuk role lain (default: aktif untuk role DOKTER, dapat dimatikan tenant — DEC-019). | MVP | OD-024 |
| IAM-FR-006 | Tenant dapat membatasi login Google ke domain tertentu. | LJT | |
| IAM-FR-007 | Role template bawaan: Tenant Admin, Dokter, Perawat/Bidan, Pendaftaran, Farmasi, Kasir, Manajer, Auditor. | MVP | |
| IAM-FR-008 | Tenant admin membuat role custom dari daftar permission. | MVP | |
| IAM-FR-009 | User ditugaskan ke satu atau lebih cabang; saat login memilih cabang aktif. | MVP | |
| IAM-FR-010 | Menu aplikasi tampil sesuai permission efektif user di cabang aktif. | MVP | |
| IAM-FR-011 | Setiap endpoint memeriksa permission di backend, terlepas dari menu. | MVP | |
| IAM-FR-012 | Jadwal login berdasarkan hari & jam jaga (dapat diaktifkan per role/user). | LJT | OD-029 |
| IAM-FR-013 | User melihat & mencabut sesi aktifnya; admin dapat mencabut sesi user lain. | MVP | |
| IAM-FR-014 | Menonaktifkan user mencabut seluruh sesinya seketika. | MVP | |
| IAM-FR-015 | Delegasi akses sementara (mis. dokter pengganti) dengan masa berlaku & persetujuan. | LJT | |
| IAM-FR-016 | User dapat ditautkan ke data tenaga kesehatan (dokter/perawat) untuk tanda tangan klinis. | MVP | |

## 4. Audit (AUD) — Stage 3

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| AUD-FR-001 | Audit log mencatat aksi tulis, login/logout, gagal login, export, dan perubahan permission. | MVP | |
| AUD-FR-002 | Audit log mencatat akses **baca** rekam medis pasien. | MVP | |
| AUD-FR-003 | Audit log tidak dapat diubah/dihapus melalui aplikasi; integritas diverifikasi dengan hash chain. | MVP | |
| AUD-FR-004 | Auditor/admin mencari audit log berdasarkan user, pasien, aksi, rentang waktu. | MVP | |
| AUD-FR-005 | Pasien (melalui klinik) dapat memperoleh daftar siapa yang mengakses rekam medisnya. | LJT | Hak subjek data |

## 5. Master Data (MST) — Stage 7

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| MST-FR-001 | CRUD fasilitas, cabang, unit/poli, ruang layanan, lokasi farmasi. | MVP | |
| MST-FR-002 | CRUD tenaga kesehatan: nama, NIK, jenis, spesialisasi, STR, SIP & masa berlaku. | MVP | |
| MST-FR-003 | Peringatan STR/SIP yang akan kedaluwarsa. | LJT | |
| MST-FR-004 | CRUD layanan: konsultasi, tindakan, paket, administrasi. | MVP | |
| MST-FR-005 | Tarif per layanan × cabang × kategori penjamin dengan periode berlaku. | MVP | |
| MST-FR-006 | CRUD penjamin: Umum, Asuransi (nama, kode), Perusahaan (kontrak). | MVP | |
| MST-FR-007 | Satuan & konversi (mis. 1 box = 10 strip = 100 tablet). | MVP | |
| MST-FR-008 | Impor/ekspor Excel/CSV dengan dry-run dan laporan error per baris. | MVP | |
| MST-FR-009 | Perubahan master tercatat (before/after). | MVP | |
| MST-FR-010 | Master supplier obat. | MVP | |
| MST-FR-011 | Wilayah administratif (provinsi–kelurahan) untuk alamat pasien. | MVP | Sumber data: OD-062 |

## 6. Terminologi (TRM) — Stage 7

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| TRM-FR-001 | ICD-10 tersedia dengan kode asli, display Bahasa Indonesia, dan versi sumber. | MVP | OD-030 |
| TRM-FR-002 | ICD-9-CM (subset tindakan) tersedia dengan kode asli & versi. | MVP | OD-030 |
| TRM-FR-003 | Tenant dapat menandai diagnosis/tindakan favorit; subset divalidasi tenaga medis. | MVP | [REVIEW-MEDIS] |
| TRM-FR-004 | Pencarian kode berdasarkan kode atau kata kunci (sinonim). | MVP | |
| TRM-FR-005 | Referensi obat menggunakan KFA SATUSEHAT. | MVP | OD-031 |

## 7. Pasien & Registrasi (REG) — Stage 8

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| REG-FR-001 | Registrasi pasien baru dengan MRN otomatis. Data wajib minimal: nama, tanggal lahir, jenis kelamin, NIK/identitas lain, alamat, telepon. | MVP | Daftar final: [REVIEW-MEDIS] |
| REG-FR-002 | Pasien tanpa NIK (bayi baru lahir, WNA, tanpa identitas) dapat didaftarkan dengan identitas alternatif. | MVP | |
| REG-FR-003 | Pencarian pasien berdasarkan nama (toleran salah ketik), NIK, MRN, telepon, tanggal lahir. | MVP | |
| REG-FR-004 | Sistem menampilkan kandidat duplikat sebelum pasien baru disimpan. | MVP | |
| REG-FR-005 | Penggabungan (merge) dua rekam pasien dengan permission khusus, tanpa menghapus data, teraudit. | MVP | |
| REG-FR-006 | Kontak darurat & wali (relasi, nama, telepon). | MVP | |
| REG-FR-007 | Penjamin pasien: Umum / Asuransi (no. polis, masa berlaku) / Perusahaan (no. karyawan). Satu pasien dapat memiliki beberapa penjamin. | MVP | |
| REG-FR-008 | Consent umum pasien tercatat dengan versi dokumen & waktu. | MVP | [REVIEW-MEDIS] |
| REG-FR-009 | Data NIK disimpan terenkripsi; pencarian NIK tidak membuka nilai asli di log. | MVP | |
| REG-FR-010 | Cetak kartu pasien / label. | LJT | |
| REG-FR-011 | Lookup nomor IHS SATUSEHAT berdasarkan NIK saat registrasi. | MVP | Stage 12 |
| REG-FR-012 | Pasien dapat dipakai lintas cabang dalam satu tenant. | MVP | OD-022 |

## 8. Jadwal & Antrean (SCH) — Stage 8

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| SCH-FR-001 | Jadwal praktik dokter per cabang/poli: hari, jam, kuota. | MVP | |
| SCH-FR-002 | Pengecualian jadwal (cuti, libur). | MVP | |
| SCH-FR-003 | Appointment oleh petugas berdasarkan slot & kuota. | MVP | |
| SCH-FR-004 | Appointment mandiri oleh pasien via Android. | LJT | Stage 13 |
| SCH-FR-005 | Walk-in langsung menghasilkan kunjungan & nomor antrean. | MVP | |
| SCH-FR-006 | Check-in appointment mengubah status menjadi hadir & memberi nomor antrean. | MVP | |
| SCH-FR-007 | Nomor antrean unik per cabang/poli/hari, aman terhadap pendaftaran bersamaan. | MVP | |
| SCH-FR-008 | Panggil, lewati, panggil ulang antrean; tampilan layar TV real-time. | MVP | |
| SCH-FR-009 | Suara panggilan antrean. | LJT | |
| SCH-FR-010 | Pembatalan & reschedule appointment dengan alasan. | MVP | |
| SCH-FR-011 | Auto no-show setelah batas waktu yang dapat dikonfigurasi. | MVP | |
| SCH-FR-012 | Pengingat appointment ke pasien (tanpa informasi medis). | LJT | OD-012 |
| SCH-FR-013 | Status kunjungan terlihat di papan kerja: Terdaftar → Hadir → Triase → Diperiksa → Farmasi → Kasir → Selesai. | MVP | Urutan farmasi/kasir: OD-008 |

## 9. Klinis & Rekam Medis (CLN) — Stage 9

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| CLN-FR-001 | Worklist dokter: daftar pasien antre untuk dokter & cabang aktif. | MVP | |
| CLN-FR-002 | Perawat merekam tanda vital: TD, nadi, napas, suhu, SpO₂, BB, TB, IMT otomatis. | MVP | [REVIEW-MEDIS] |
| CLN-FR-003 | Peringatan nilai vital di luar rentang wajar. | LJT | [REVIEW-MEDIS] |
| CLN-FR-004 | Anamnesis & SOAP (Subjective, Objective, Assessment, Plan). | MVP | [REVIEW-MEDIS] |
| CLN-FR-005 | Template klinis per spesialisasi (minimal: umum, gigi, anak, kebidanan). | MVP | OD-035, [REVIEW-MEDIS] |
| CLN-FR-006 | Pencatatan alergi (zat, reaksi, tingkat keparahan) tampil menonjol di header pasien. | MVP | [REVIEW-MEDIS] |
| CLN-FR-007 | Riwayat penyakit & obat yang sedang digunakan. | MVP | [REVIEW-MEDIS] |
| CLN-FR-008 | Diagnosis ICD-10: satu primer wajib, sekunder opsional, dengan status (baru/lama). | MVP | [REVIEW-MEDIS] |
| CLN-FR-009 | Tindakan ICD-9-CM dengan pelaksana; otomatis masuk ke tagihan. | MVP | |
| CLN-FR-010 | Resep elektronik non-racikan: obat, dosis, frekuensi, rute, durasi, jumlah, aturan pakai. | MVP | [REVIEW-MEDIS] |
| CLN-FR-011 | Resep racikan: komponen, jumlah bungkus/kapsul, aturan pakai. | MVP | [REVIEW-MEDIS] |
| CLN-FR-012 | Peringatan alergi dan duplikasi obat saat meresepkan. | MVP | [REVIEW-MEDIS] |
| CLN-FR-013 | Peringatan interaksi obat. | LJT | OD-033 |
| CLN-FR-014 | Order pemeriksaan lab ke aplikasi lab eksisting. | MVP | DEC-009, OD-059 |
| CLN-FR-015 | Hasil lab tampil di encounter & riwayat pasien; fallback input hasil manual / unggah PDF. | MVP | |
| CLN-FR-016 | Riwayat kunjungan sebelumnya terlihat di layar encounter. | MVP | |
| CLN-FR-017 | Pengesahan rekam medis oleh dokter penanggung jawab mengunci catatan. | MVP | [REVIEW-MEDIS] |
| CLN-FR-018 | Diagnosis primer & SOAP wajib terisi sebelum pengesahan. | MVP | [REVIEW-MEDIS] |
| CLN-FR-019 | Addendum untuk catatan yang sudah disahkan, dengan alasan & tanda tangan. | MVP | |
| CLN-FR-020 | Resume medis rawat jalan (PDF). | MVP | [REVIEW-MEDIS] |
| CLN-FR-021 | Surat keterangan sehat & sakit (PDF, nomor surat, kop klinik). | MVP | |
| CLN-FR-022 | Surat rujukan keluar. | MVP | |
| CLN-FR-023 | Rencana tindak lanjut / jadwal kontrol membuat appointment. | MVP | |
| CLN-FR-024 | Informed consent tindakan tercatat. | LJT | [REVIEW-MEDIS] |
| CLN-FR-025 | Odontogram untuk poli gigi. | LJT | [REVIEW-MEDIS] |
| CLN-FR-026 | Tanda tangan elektronik tersertifikasi untuk dokumen medis. | LJT | OD-034 |

## 10. Farmasi & Inventori (PHM) — Stage 10

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| PHM-FR-001 | Master obat tenant: nama generik & dagang, bentuk, kekuatan, satuan, golongan (bebas, bebas terbatas, keras, narkotika, psikotropika), referensi KFA. | MVP | |
| PHM-FR-002 | Harga: harga beli, HNA, HET, harga jual per kategori penjamin. | MVP | |
| PHM-FR-003 | Penerimaan barang dari supplier dengan no. faktur, batch, tanggal kedaluwarsa, harga. | MVP | |
| PHM-FR-004 | Stok dicatat per batch per lokasi sebagai ledger mutasi. | MVP | |
| PHM-FR-005 | Pemilihan batch otomatis FEFO (default) atau FIFO per tenant. | MVP | OD-037 |
| PHM-FR-006 | Worklist resep: resep masuk dari dokter. | MVP | |
| PHM-FR-007 | Telaah resep (administratif, farmasetik, klinis) dengan checklist. | MVP | [REVIEW-MEDIS] |
| PHM-FR-008 | Dispensing mengurangi stok & menambahkan baris obat ke tagihan. | MVP | |
| PHM-FR-009 | Resep parsial: sisa tercatat dan dapat diambil kemudian. | MVP | |
| PHM-FR-010 | Substitusi obat dengan persetujuan dokter di aplikasi. | MVP | |
| PHM-FR-011 | Cetak etiket obat. | MVP | |
| PHM-FR-012 | Penjualan obat bebas tanpa kunjungan. | MVP | |
| PHM-FR-013 | Stok negatif & obat kedaluwarsa tidak dapat dikeluarkan. | MVP | |
| PHM-FR-014 | Peringatan stok minimum & mendekati kedaluwarsa. | MVP | |
| PHM-FR-015 | Retur ke supplier & retur dari pasien. | LJT | |
| PHM-FR-016 | Penyesuaian stok dengan alasan & persetujuan. | MVP | |
| PHM-FR-017 | Stock opname dengan selisih yang disetujui. | MVP | |
| PHM-FR-018 | Transfer stok antar lokasi/cabang. | LJT | |
| PHM-FR-019 | Akses obat narkotika/psikotropika dibatasi permission khusus & laporan pemakaian. | MVP | REG-10 |
| PHM-FR-020 | Valuasi stok untuk laporan HPP. | LJT | OD-038 |

## 11. Billing & Pembayaran (BIL) — Stage 11

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| BIL-FR-001 | Invoice terbentuk otomatis dari konsultasi, tindakan, obat, lab, dan item lain. | MVP | |
| BIL-FR-002 | Harga pada invoice adalah snapshot tarif saat transaksi. | MVP | |
| BIL-FR-003 | Diskon per baris / total dengan batas & persetujuan. | MVP | OD-041 |
| BIL-FR-004 | Pembagian tagihan antara penjamin & pasien (co-pay, plafon). | MVP | |
| BIL-FR-005 | Pembayaran tunai, debit, kartu kredit (pencatatan EDC), transfer. | MVP | |
| BIL-FR-006 | QRIS dinamis via payment gateway dengan callback terverifikasi. | MVP | OD-039 |
| BIL-FR-007 | Satu invoice dapat dibayar dengan beberapa metode (split tender) dan sebagian. | MVP | |
| BIL-FR-008 | Kwitansi / struk (cetak & PDF). | MVP | |
| BIL-FR-009 | Void invoice hanya via persetujuan; invoice baru menggantikan. | MVP | |
| BIL-FR-010 | Refund dengan alasan & persetujuan manajer (maker–checker). | MVP | |
| BIL-FR-011 | Buka & tutup shift kasir; perhitungan kas fisik vs sistem, selisih tercatat. | MVP | |
| BIL-FR-012 | Rekonsiliasi harian transaksi QRIS dengan laporan settlement. | MVP | |
| BIL-FR-013 | Piutang penjamin perusahaan/asuransi & pelunasannya. | MVP | |
| BIL-FR-014 | Tagihan kolektif ke perusahaan per periode. | LJT | |
| BIL-FR-015 | Deposit pasien. | LJT | |
| BIL-FR-016 | Laporan transaksi tidak wajar (void/refund/diskon berlebih, selisih kas). | MVP | |
| BIL-FR-017 | Kebutuhan pajak / e-Faktur pada invoice. | LJT | OD-040 |

## 12. SATUSEHAT (INT) — Stage 12

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| INT-FR-001 | Kredensial SATUSEHAT per fasilitas disimpan aman & dapat diuji koneksinya. | MVP | |
| INT-FR-002 | Sinkronisasi Organization, Location, Practitioner. | MVP | |
| INT-FR-003 | Lookup IHS Patient by NIK. | MVP | |
| INT-FR-004 | Pengiriman Encounter, Condition, Observation (vital), Procedure setelah pengesahan. | MVP | |
| INT-FR-005 | Pengiriman MedicationRequest & MedicationDispense. | MVP | |
| INT-FR-006 | Pengiriman ServiceRequest / DiagnosticReport lab. | LJT | Bergantung vendor lab |
| INT-FR-007 | Pengiriman Composition / resume. | LJT | OD-042 |
| INT-FR-008 | Validasi payload sebelum kirim; error ditampilkan dengan jelas. | MVP | |
| INT-FR-009 | Retry otomatis, dead-letter, kirim ulang manual teraudit. | MVP | |
| INT-FR-010 | Dashboard status integrasi per tenant. | MVP | |
| INT-FR-011 | Rekonsiliasi data lokal vs terkirim. | MVP | |
| INT-FR-012 | Update resource ketika ada addendum. | MVP | |

## 13. BPJS (BPJ) — Lanjutan

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| BPJ-FR-001 | Cek kepesertaan BPJS saat registrasi. | LJT | DEC-006 |
| BPJ-FR-002 | Pendaftaran & pelayanan via P-Care untuk FKTP. | LJT | |
| BPJ-FR-003 | Rujukan online BPJS. | LJT | |
| BPJ-FR-004 | Model data penjamin MVP menyiapkan field kepesertaan BPJS. | MVP | Agar tidak perlu migrasi besar |

## 14. Aplikasi Pasien (POR) — Stage 13

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| POR-FR-001 | Registrasi akun pasien & penautan ke rekam pasien di klinik dengan verifikasi OTP. | LJT | Seluruh Stage 13 = LJT (usulan) |
| POR-FR-002 | Riwayat kunjungan & diagnosis (hanya yang disahkan). | LJT | |
| POR-FR-003 | Riwayat resep & obat. | LJT | |
| POR-FR-004 | Hasil laboratorium. | LJT | |
| POR-FR-005 | Unduh dokumen medis. | LJT | |
| POR-FR-006 | Jadwal kontrol & pengingat. | LJT | |
| POR-FR-007 | Akun wali untuk anak/tanggungan. | LJT | OD-044 |
| POR-FR-008 | Kelola & cabut perangkat. | LJT | |
| POR-FR-009 | Notifikasi tanpa informasi medis sensitif. | LJT | |

## 15. Pelaporan (RPT) — Stage 14

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| RPT-FR-001 | Laporan kunjungan harian/bulanan per cabang, poli, dokter, penjamin. | MVP | |
| RPT-FR-002 | 10 besar diagnosis per periode. | MVP | |
| RPT-FR-003 | Laporan pendapatan per layanan, metode bayar, penjamin. | MVP | |
| RPT-FR-004 | Laporan closing kasir. | MVP | |
| RPT-FR-005 | Laporan stok, mutasi, mendekati kedaluwarsa. | MVP | |
| RPT-FR-006 | Laporan pemakaian narkotika/psikotropika. | MVP | Format: REG-10 |
| RPT-FR-007 | Laporan piutang. | MVP | |
| RPT-FR-008 | Export Excel/CSV/PDF dengan watermark & audit. | MVP | |
| RPT-FR-009 | Dashboard ringkas harian untuk manajer. | MVP | |
| RPT-FR-010 | Report builder berbasis katalog data (tanpa SQL). | LJT | |
| RPT-FR-011 | Laporan terjadwal & distribusi. | LJT | |
| RPT-FR-012 | Laporan waktu tunggu pasien. | LJT | |

## 16. Dokumen & Notifikasi (DOC, NTF)

| ID | Requirement | Prioritas | Catatan |
|---|---|---|---|
| DOC-FR-001 | Template dokumen (resume, surat, kwitansi, etiket) memakai kop & logo tenant. | MVP | |
| DOC-FR-002 | Dokumen PDF tersimpan & dapat diunduh ulang dengan isi sama (versi tersimpan). | MVP | |
| DOC-FR-003 | Unggah berkas pendukung (hasil lab luar, foto) ke rekam pasien. | MVP | |
| NTF-FR-001 | Email transaksional: undangan user, reset password. | MVP | |
| NTF-FR-002 | Pengingat appointment via WhatsApp/SMS. | LJT | OD-012 |
