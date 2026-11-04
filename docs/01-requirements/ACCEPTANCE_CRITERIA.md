# Acceptance Criteria — ClinicRME SaaS

| | |
|---|---|
| Versi | 1.0 — Disetujui (DEC-015) |
| Tanggal | 3 November 2026 |
| Stage | 1 |

**Cakupan:** semua requirement fungsional **MVP**. Untuk NFR, target angka di [NFR.md](NFR.md) adalah acceptance criteria-nya. Requirement **Lanjutan** diberi AC saat dijadwalkan.

**Format:** `AC-<REQ-ID>-<n>`. Setiap AC harus dapat diuji otomatis atau manual dengan hasil lulus/gagal yang jelas. Istilah "user tenant lain" berarti user yang login di tenant berbeda.

---

## GEN — Aturan Umum

| AC ID | Kriteria |
|---|---|
| AC-GEN-FR-001-1 | User tenant A yang memanggil API resource milik tenant B menerima 404, dan tidak ada data B dalam respons. |
| AC-GEN-FR-001-2 | Query langsung ke database dengan role aplikasi tanpa tenant context mengembalikan 0 baris pada tabel tenant. |
| AC-GEN-FR-002-1 | Setiap operasi create/update/delete menghasilkan satu entri audit berisi user, aksi, resource, waktu, IP. |
| AC-GEN-FR-003-1 | Upaya mengubah/menghapus catatan klinis SIGNED, invoice ISSUED, atau pembayaran melalui API ditolak (409/403). |
| AC-GEN-FR-003-2 | Upaya `UPDATE`/`DELETE` langsung via SQL dengan role aplikasi pada data tersebut ditolak oleh database. |
| AC-GEN-FR-004-1 | Setiap layar daftar menyediakan pencarian, filter, sortir, dan paginasi; daftar 10.000 baris tetap dimuat per halaman. |
| AC-GEN-FR-005-1 | Seluruh label UI berbahasa Indonesia; tanggal tampil `dd/MM/yyyy`; uang `Rp 1.234.567`. |
| AC-GEN-FR-005-2 | Waktu tersimpan UTC dan ditampilkan sesuai zona waktu cabang (WIB/WITA/WIT). |
| AC-GEN-FR-006-1 | Nomor MRN, kunjungan, resep, invoice unik per tenant; 100 pembuatan bersamaan tidak menghasilkan duplikat. |
| AC-GEN-FR-006-2 | Tenant admin dapat mengatur prefix & pola nomor; pola baru berlaku untuk dokumen berikutnya saja. |
| AC-GEN-FR-007-1 | Dua user menyimpan data yang sama berdasarkan versi yang sama → simpan kedua ditolak dengan pesan "Data telah diubah oleh pengguna lain". |

## PLT — Platform & Tenant

| AC ID | Kriteria |
|---|---|
| AC-PLT-FR-001-1 | Platform admin membuat tenant → email undangan terkirim ke tenant admin; tenant berstatus TRIAL atau ACTIVE sesuai pilihan. |
| AC-PLT-FR-002-1 | Tipe tenant wajib dipilih dari Klinik Utama / Klinik Pratama / Praktik Mandiri. |
| AC-PLT-FR-003-1 | Paket menyimpan batas user, cabang, dan daftar fitur; tenant selalu terhubung ke tepat satu paket aktif. |
| AC-PLT-FR-004-1 | Menambah user/cabang melebihi batas paket via API ditolak dengan kode `PLT-403-QUOTA` dan pesan menyebut batasnya. |
| AC-PLT-FR-005-1 | Perubahan status tenant mewajibkan alasan dan tercatat di histori status (dari, ke, alasan, aktor, waktu). |
| AC-PLT-FR-006-1 | Tenant SUSPENDED: login user non-admin ditolak; tenant admin dapat login dan hanya mengakses menu langganan & ekspor. |
| AC-PLT-FR-007-1 | Logo & kop yang diunggah tampil pada dokumen PDF berikutnya. |
| AC-PLT-FR-008-1 | Permintaan ekspor menghasilkan arsip terenkripsi berisi seluruh data tenant; tautan unduh kedaluwarsa sesuai konfigurasi (default 24 jam). |
| AC-PLT-FR-008-2 | Permintaan & unduhan ekspor tercatat di audit. |
| AC-PLT-FR-009-1 | Token platform admin yang memanggil endpoint klinis tenant ditolak (403). |
| AC-PLT-FR-009-2 | Break-glass mewajibkan alasan, berlaku maksimal waktu yang ditentukan, membuat notifikasi ke tenant admin, dan seluruh aksinya diaudit. |
| AC-PLT-FR-011-1 | Fitur yang dimatikan flag-nya tidak tampil di menu dan endpoint-nya menolak akses. |
| AC-PLT-FR-013-1 | Tenant TERMINATED tidak menghapus data klinis; data hanya dapat diakses untuk ekspor/serah terima oleh pihak berwenang. |

## IAM — Identitas & Akses

| AC ID | Kriteria |
|---|---|
| AC-IAM-FR-001-1 | Tidak ada endpoint pendaftaran mandiri staf; user hanya terbentuk dari undangan yang diterima. |
| AC-IAM-FR-001-2 | Undangan kedaluwarsa (default 7 hari) tidak dapat dipakai. |
| AC-IAM-FR-002-1 | Login Google dengan akun yang tidak tertaut & tanpa undangan ditolak. |
| AC-IAM-FR-002-2 | Penautan disimpan berdasarkan `sub` Google; mengganti email di akun Google tidak memutus tautan. |
| AC-IAM-FR-002-3 | Callback dengan `state` atau `nonce` tidak cocok ditolak. |
| AC-IAM-FR-003-1 | Password harus ≥ 10 karakter dan tidak termasuk daftar password umum. |
| AC-IAM-FR-003-2 | 5 kali gagal berturut-turut mengunci akun 15 menit; peristiwa tercatat di audit. |
| AC-IAM-FR-004-1 | Tautan reset berlaku 30 menit dan sekali pakai; respons permintaan reset sama untuk email terdaftar maupun tidak. |
| AC-IAM-FR-005-1 | User dengan role admin tidak dapat mengakses menu apa pun sebelum MFA diverifikasi pada sesi tersebut. |
| AC-IAM-FR-005-2 | Recovery code tersedia saat MFA diaktifkan dan masing-masing hanya dapat dipakai sekali. |
| AC-IAM-FR-007-1 | Tenant baru otomatis memiliki 8 role template dengan permission default. |
| AC-IAM-FR-008-1 | Tenant admin membuat role custom dengan memilih permission; perubahan role berlaku pada request berikutnya user terkait. |
| AC-IAM-FR-009-1 | User dengan >1 cabang wajib memilih cabang aktif; data cabang lain tidak tampil kecuali permission lintas cabang. |
| AC-IAM-FR-010-1 | Menu yang permission-nya tidak dimiliki tidak muncul di sidebar. |
| AC-IAM-FR-011-1 | Test otomatis memanggil setiap endpoint dengan user tanpa permission → semua 403. |
| AC-IAM-FR-011-2 | Endpoint tanpa deklarasi permission gagal saat build/test (deny by default). |
| AC-IAM-FR-013-1 | User melihat daftar sesi (perangkat, IP, waktu) dan mencabutnya; sesi tercabut tidak dapat dipakai lagi. |
| AC-IAM-FR-014-1 | Setelah user dinonaktifkan, request berikutnya dari sesi mana pun ditolak dalam ≤ 1 menit. |
| AC-IAM-FR-016-1 | Tanda tangan klinis (pengesahan RM, resep) hanya dapat dilakukan user yang tertaut ke data tenaga kesehatan dengan SIP berlaku. |

## AUD — Audit

| AC ID | Kriteria |
|---|---|
| AC-AUD-FR-001-1 | Login sukses/gagal, logout, export, perubahan role/permission menghasilkan entri audit. |
| AC-AUD-FR-002-1 | Membuka layar encounter / riwayat pasien menghasilkan entri `READ` dengan ID pasien. |
| AC-AUD-FR-003-1 | Role aplikasi tidak memiliki hak UPDATE/DELETE pada tabel audit. |
| AC-AUD-FR-003-2 | Job verifikasi hash chain mendeteksi baris yang diubah secara manual (uji dengan manipulasi di DB test). |
| AC-AUD-FR-004-1 | Pencarian audit berdasarkan user, pasien, aksi, dan rentang tanggal mengembalikan hasil yang benar; hasil dapat diekspor. |

## MST — Master Data

| AC ID | Kriteria |
|---|---|
| AC-MST-FR-001-1 | Fasilitas, cabang, unit, ruang, lokasi farmasi dapat dibuat, diubah, dinonaktifkan (tidak dihapus bila sudah dipakai). |
| AC-MST-FR-002-1 | Tenaga kesehatan menyimpan STR & SIP dengan tanggal berlaku; NIK unik per tenant. |
| AC-MST-FR-004-1 | Layanan memiliki jenis (konsultasi, tindakan, paket, administrasi) dan kode unik per tenant. |
| AC-MST-FR-005-1 | Tarif dipilih berdasarkan layanan, cabang, kategori penjamin, dan tanggal transaksi; periode tarif tidak boleh tumpang tindih. |
| AC-MST-FR-005-2 | Mengubah tarif membuat periode baru; tarif lama tetap tersimpan. |
| AC-MST-FR-006-1 | Penjamin bertipe Umum/Asuransi/Perusahaan; Perusahaan dapat memiliki kontrak tarif. |
| AC-MST-FR-007-1 | Konversi satuan berantai dihitung benar (1 box = 10 strip = 100 tablet → 2 box = 200 tablet). |
| AC-MST-FR-008-1 | Dry-run impor menampilkan error per baris tanpa menyimpan apa pun. |
| AC-MST-FR-008-2 | Impor bersifat all-or-nothing; satu baris gagal saat commit membatalkan seluruh impor. |
| AC-MST-FR-008-3 | Ekspor menghasilkan file yang dapat diimpor ulang tanpa perubahan. |
| AC-MST-FR-009-1 | Setiap perubahan master menyimpan nilai sebelum & sesudah di audit. |
| AC-MST-FR-010-1 | Supplier dapat dikelola dan dipilih pada penerimaan barang. |
| AC-MST-FR-011-1 | Alamat pasien memilih provinsi → kab/kota → kecamatan → kelurahan secara berjenjang. |

## TRM — Terminologi

| AC ID | Kriteria |
|---|---|
| AC-TRM-FR-001-1 | Kode ICD-10 tersimpan tanpa modifikasi beserta display Indonesia dan versi sumber. |
| AC-TRM-FR-002-1 | Kode ICD-9-CM subset tersimpan dengan versi sumber. |
| AC-TRM-FR-003-1 | Favorit tenant tampil teratas di pencarian; status validasi (oleh siapa, kapan) tercatat. |
| AC-TRM-FR-004-1 | Pencarian "demam" atau "R50" menampilkan kode terkait dalam < 500 ms. |
| AC-TRM-FR-005-1 | Item obat tenant dapat ditautkan ke kode KFA; kode KFA dipakai saat kirim ke SATUSEHAT. |

## REG — Pasien & Registrasi

| AC ID | Kriteria |
|---|---|
| AC-REG-FR-001-1 | Simpan pasien tanpa field wajib ditolak dengan penanda field yang kurang. |
| AC-REG-FR-001-2 | MRN dibuat otomatis sesuai pola tenant dan tidak dapat diubah. |
| AC-REG-FR-002-1 | Pasien dapat disimpan dengan jenis identitas Paspor / Tanpa Identitas / Bayi (identitas ibu); NIK tidak wajib untuk jenis tersebut. |
| AC-REG-FR-003-1 | Pencarian "Ahmad Sutrisno" menemukan "Achmad Sutrisno" (toleran salah ketik). |
| AC-REG-FR-003-2 | Pencarian NIK lengkap menemukan pasien yang tepat; NIK parsial tidak didukung. |
| AC-REG-FR-004-1 | Data dengan NIK sama → peringatan duplikat pasti; nama mirip + tanggal lahir + jenis kelamin sama → kandidat ditampilkan. |
| AC-REG-FR-004-2 | Melanjutkan simpan meskipun ada kandidat mewajibkan alasan yang tercatat. |
| AC-REG-FR-005-1 | Merge memindahkan seluruh kunjungan ke pasien tujuan; pasien sumber berstatus MERGED dan mengarah ke tujuan; tidak ada data terhapus. |
| AC-REG-FR-005-2 | Hanya user dengan permission `patient.merge` yang dapat melakukan merge. |
| AC-REG-FR-006-1 | Pasien dapat memiliki ≥ 1 kontak darurat; salah satu dapat ditandai sebagai wali. |
| AC-REG-FR-007-1 | Pasien dapat memiliki beberapa penjamin dengan masa berlaku; penjamin kedaluwarsa tidak dapat dipilih saat kunjungan. |
| AC-REG-FR-008-1 | Consent umum menyimpan versi dokumen, waktu, dan petugas; pasien tanpa consent ditandai di layar. |
| AC-REG-FR-009-1 | NIK di database tersimpan terenkripsi; log aplikasi & audit tidak memuat NIK utuh. |
| AC-REG-FR-011-1 | Registrasi dengan NIK memicu lookup IHS; hasil tersimpan; kegagalan tidak menghalangi registrasi. |
| AC-REG-FR-012-1 | Pasien yang didaftarkan di cabang A dapat ditemukan dan dilayani di cabang B dalam tenant yang sama. |

## SCH — Jadwal & Antrean

| AC ID | Kriteria |
|---|---|
| AC-SCH-FR-001-1 | Jadwal dokter per hari & jam dengan kuota; jadwal bertabrakan untuk dokter yang sama ditolak. |
| AC-SCH-FR-002-1 | Slot pada tanggal cuti/libur tidak dapat dipesan; appointment yang sudah ada ditandai untuk dijadwal ulang. |
| AC-SCH-FR-003-1 | Appointment ditolak bila kuota slot penuh. |
| AC-SCH-FR-005-1 | Walk-in menghasilkan kunjungan ARRIVED dan nomor antrean dalam satu langkah. |
| AC-SCH-FR-006-1 | Check-in appointment mengubah status ke ARRIVED dan memberi nomor antrean. |
| AC-SCH-FR-007-1 | 50 pendaftaran bersamaan pada poli yang sama menghasilkan 50 nomor berbeda dan berurutan. |
| AC-SCH-FR-008-1 | Memanggil antrean memperbarui layar TV dalam ≤ 2 detik tanpa refresh manual. |
| AC-SCH-FR-008-2 | Antrean yang dilewati dapat dipanggil ulang; riwayat panggilan tercatat. |
| AC-SCH-FR-010-1 | Pembatalan & reschedule mewajibkan alasan; kuota slot lama dikembalikan. |
| AC-SCH-FR-011-1 | Appointment yang tidak check-in hingga batas waktu (default 60 menit setelah slot) berubah menjadi NO_SHOW otomatis. |
| AC-SCH-FR-013-1 | Papan kerja menampilkan status kunjungan terkini per pasien dan berubah sesuai alur. |

## CLN — Klinis & Rekam Medis

| AC ID | Kriteria |
|---|---|
| AC-CLN-FR-001-1 | Worklist dokter hanya menampilkan pasien untuk dokter & cabang aktif, berurutan nomor antrean. |
| AC-CLN-FR-002-1 | Vital tersimpan dengan satuan; IMT dihitung otomatis dari BB & TB. |
| AC-CLN-FR-002-2 | Nilai di luar batas fisik mungkin (mis. suhu > 45 °C) ditolak sebagai salah input. |
| AC-CLN-FR-004-1 | SOAP tersimpan sebagai draft otomatis minimal setiap 30 detik saat ada perubahan. |
| AC-CLN-FR-005-1 | Tersedia template Umum, Gigi, Anak, Kebidanan; tenant dapat memilih template default per poli. |
| AC-CLN-FR-006-1 | Alergi aktif tampil sebagai banner di header pasien pada semua layar klinis & farmasi. |
| AC-CLN-FR-007-1 | Riwayat penyakit & obat rutin dapat dicatat dan tampil di ringkasan pasien. |
| AC-CLN-FR-008-1 | Encounter hanya boleh memiliki satu diagnosis primer; sekunder tidak dibatasi. |
| AC-CLN-FR-009-1 | Tindakan yang dicatat otomatis muncul sebagai baris draft invoice dengan tarif yang berlaku. |
| AC-CLN-FR-010-1 | Resep non-racikan menyimpan obat, dosis, frekuensi, rute, durasi, jumlah, aturan pakai; field wajib divalidasi. |
| AC-CLN-FR-011-1 | Resep racikan menyimpan komponen & jumlah, bentuk sediaan, jumlah bungkus/kapsul, aturan pakai. |
| AC-CLN-FR-012-1 | Meresepkan obat yang mengandung zat alergen pasien menampilkan peringatan yang harus dikonfirmasi dengan alasan. |
| AC-CLN-FR-012-2 | Obat yang sama dua kali dalam satu resep menampilkan peringatan duplikasi. |
| AC-CLN-FR-014-1 | Order lab membuat nomor order dan terkirim ke adapter lab; status order tampil (ORDERED/RECEIVED/RESULTED). |
| AC-CLN-FR-015-1 | Hasil dari adapter tampil di encounter; bila adapter tidak tersedia, hasil dapat diinput manual atau diunggah PDF dengan penanda sumber. |
| AC-CLN-FR-016-1 | Layar encounter menampilkan minimal 5 kunjungan terakhir (diagnosis, resep) dengan tautan detail. |
| AC-CLN-FR-017-1 | Hanya dokter penanggung jawab kunjungan (atau yang diberi akses) yang dapat mengesahkan. |
| AC-CLN-FR-017-2 | Setelah disahkan, seluruh isi catatan (SOAP, diagnosis, tindakan, resep) tidak dapat diubah via UI maupun API. |
| AC-CLN-FR-018-1 | Pengesahan ditolak bila SOAP kosong atau diagnosis primer belum ada, dengan daftar kekurangan. |
| AC-CLN-FR-019-1 | Addendum mewajibkan alasan, tersimpan terpisah, ditandatangani, dan tampil berurutan di bawah catatan asli. |
| AC-CLN-FR-020-1 | Resume medis PDF memuat identitas pasien, tanggal, diagnosis, tindakan, terapi, dokter, kop klinik. |
| AC-CLN-FR-021-1 | Surat sehat/sakit memiliki nomor surat unik, masa istirahat (untuk surat sakit), dan identitas dokter. |
| AC-CLN-FR-022-1 | Surat rujukan memuat tujuan, alasan, diagnosis, ringkasan klinis, dan nomor rujukan. |
| AC-CLN-FR-023-1 | Rencana kontrol dengan tanggal membuat appointment ke dokter/poli terkait. |

## PHM — Farmasi & Inventori

| AC ID | Kriteria |
|---|---|
| AC-PHM-FR-001-1 | Obat wajib memiliki golongan; golongan menentukan aturan penjualan bebas dan permission akses. |
| AC-PHM-FR-002-1 | Harga jual dipilih berdasarkan kategori penjamin pasien; harga beli tidak tampil di layar kasir. |
| AC-PHM-FR-003-1 | Penerimaan barang wajib mencatat no. faktur, batch, tanggal kedaluwarsa, jumlah, harga; menambah stok batch terkait. |
| AC-PHM-FR-004-1 | Saldo stok setiap batch sama dengan jumlah seluruh mutasinya (test rekonsiliasi otomatis). |
| AC-PHM-FR-005-1 | Dengan FEFO, batch dengan tanggal kedaluwarsa terdekat yang masih valid dipilih pertama. |
| AC-PHM-FR-006-1 | Resep yang disahkan dokter muncul di worklist farmasi cabang dalam ≤ 5 detik. |
| AC-PHM-FR-007-1 | Resep tidak dapat didispensing sebelum checklist telaah disimpan. |
| AC-PHM-FR-008-1 | Dispensing mengurangi stok batch terkait dan menambahkan baris obat ke invoice kunjungan dalam satu transaksi. |
| AC-PHM-FR-009-1 | Penyerahan sebagian menyimpan sisa per item; sisa dapat didispensing kemudian dari resep yang sama. |
| AC-PHM-FR-010-1 | Substitusi baru dapat didispensing setelah dokter menyetujui; resep menyimpan obat asli, pengganti, alasan, penyetuju. |
| AC-PHM-FR-011-1 | Etiket memuat nama pasien, tanggal, nama obat, aturan pakai; dapat dicetak ke printer label/thermal. |
| AC-PHM-FR-012-1 | Penjualan bebas hanya mengizinkan obat golongan bebas & bebas terbatas. |
| AC-PHM-FR-013-1 | Pengeluaran yang membuat stok batch negatif ditolak. |
| AC-PHM-FR-013-2 | Batch yang sudah kedaluwarsa tidak dapat dipilih untuk pengeluaran. |
| AC-PHM-FR-014-1 | Obat di bawah stok minimum & batch kedaluwarsa ≤ N hari (default 90) tampil di daftar peringatan. |
| AC-PHM-FR-016-1 | Penyesuaian stok mewajibkan alasan dan persetujuan user berwenang sebelum berlaku. |
| AC-PHM-FR-017-1 | Opname mencatat hasil hitung per batch; selisih menjadi mutasi ADJUST setelah disetujui. |
| AC-PHM-FR-019-1 | Obat narkotika/psikotropika hanya dapat dilihat stoknya & didispensing oleh user dengan permission khusus. |

## BIL — Billing & Pembayaran

| AC ID | Kriteria |
|---|---|
| AC-BIL-FR-001-1 | Konsultasi, tindakan, obat terdispensing, dan lab otomatis menjadi baris draft invoice kunjungan. |
| AC-BIL-FR-002-1 | Mengubah tarif setelah invoice dibuat tidak mengubah nilai invoice tersebut. |
| AC-BIL-FR-003-1 | Diskon di atas batas tenant memerlukan persetujuan user berwenang; diskon tercatat per baris. |
| AC-BIL-FR-004-1 | Invoice menampilkan porsi penjamin & porsi pasien; total porsi = total invoice. |
| AC-BIL-FR-005-1 | Pembayaran tunai menghitung kembalian; debit/kartu/transfer mewajibkan nomor referensi. |
| AC-BIL-FR-006-1 | QR dinamis ditampilkan untuk nominal tertentu; pembayaran tercatat hanya setelah callback terverifikasi. |
| AC-BIL-FR-006-2 | Callback dengan signature salah ditolak; callback ganda tidak mencatat pembayaran ganda. |
| AC-BIL-FR-007-1 | Satu invoice dapat dilunasi dengan ≥ 2 metode; status PARTIALLY_PAID sampai lunas. |
| AC-BIL-FR-008-1 | Kwitansi memuat nomor, rincian, metode bayar, kasir; dapat dicetak thermal & PDF. |
| AC-BIL-FR-009-1 | Void hanya untuk invoice belum dibayar dan memerlukan persetujuan; invoice asli tetap ada dengan status VOID. |
| AC-BIL-FR-010-1 | Refund mewajibkan alasan dan persetujuan user berbeda dari pengaju; pembayaran asal tidak berubah. |
| AC-BIL-FR-011-1 | Pembayaran tidak dapat dicatat tanpa shift terbuka. |
| AC-BIL-FR-011-2 | Tutup shift menghitung selisih kas fisik vs ekspektasi; selisih di atas toleransi mewajibkan keterangan. |
| AC-BIL-FR-012-1 | Rekonsiliasi harian menandai transaksi QRIS yang tidak ada di settlement atau sebaliknya. |
| AC-BIL-FR-013-1 | Porsi penjamin menjadi piutang; pelunasan sebagian/penuh mengurangi saldo piutang. |
| AC-BIL-FR-016-1 | Laporan transaksi tidak wajar menandai: void/refund di luar jam operasional, diskon di atas ambang, > N void per kasir per shift, selisih kas di atas toleransi. |

## INT — SATUSEHAT

| AC ID | Kriteria |
|---|---|
| AC-INT-FR-001-1 | Kredensial tersimpan di secret store (tidak di tabel biasa); tombol uji koneksi menampilkan sukses/gagal. |
| AC-INT-FR-002-1 | Organization, Location, Practitioner terkirim dan ID SATUSEHAT tersimpan. |
| AC-INT-FR-003-1 | Lookup NIK valid di sandbox mengembalikan IHS number yang tersimpan di pasien. |
| AC-INT-FR-004-1 | Pengesahan RM menghasilkan Encounter, Condition, Observation, Procedure terkirim ke sandbox dengan status sukses. |
| AC-INT-FR-005-1 | Resep & dispensing menghasilkan MedicationRequest & MedicationDispense terkirim. |
| AC-INT-FR-008-1 | Payload tidak valid tidak dikirim; error tampil per item dengan pesan yang dapat ditindaklanjuti. |
| AC-INT-FR-009-1 | Kegagalan sementara di-retry dengan backoff; setelah batas, masuk dead-letter dan admin mendapat notifikasi. |
| AC-INT-FR-009-2 | Kirim ulang manual tidak menghasilkan resource ganda. |
| AC-INT-FR-010-1 | Dashboard menampilkan jumlah terkirim/tertunda/gagal per hari dan daftar error. |
| AC-INT-FR-011-1 | Laporan rekonsiliasi menunjukkan kunjungan disahkan yang belum terkirim. |
| AC-INT-FR-012-1 | Addendum yang mengubah diagnosis mengirim update resource terkait. |

## BPJ — BPJS (MVP saja)

| AC ID | Kriteria |
|---|---|
| AC-BPJ-FR-004-1 | Penjamin pasien mendukung jenis BPJS dengan field nomor kartu & faskes tingkat pertama, meskipun belum terhubung ke BPJS. |

## RPT — Pelaporan

| AC ID | Kriteria |
|---|---|
| AC-RPT-FR-001-1 | Jumlah kunjungan pada laporan sama dengan hitungan manual dari data uji untuk filter yang sama. |
| AC-RPT-FR-002-1 | 10 besar diagnosis menghitung diagnosis primer (dan opsi termasuk sekunder) sesuai periode & cabang. |
| AC-RPT-FR-003-1 | Total pendapatan = Σ pembayaran − Σ refund pada periode; dapat dipecah per layanan, metode, penjamin. |
| AC-RPT-FR-004-1 | Laporan closing menampilkan modal, penerimaan per metode, ekspektasi, kas fisik, selisih per shift. |
| AC-RPT-FR-005-1 | Laporan stok menampilkan saldo per obat/batch per lokasi pada tanggal tertentu; mutasi per periode. |
| AC-RPT-FR-006-1 | Laporan narkotika/psikotropika menampilkan saldo awal, penerimaan, pengeluaran, saldo akhir per obat per periode. |
| AC-RPT-FR-007-1 | Laporan piutang menampilkan saldo per penjamin dengan umur piutang. |
| AC-RPT-FR-008-1 | Export Excel/CSV/PDF tersedia untuk semua laporan MVP; berkas memuat watermark (user, waktu) dan tercatat di audit. |
| AC-RPT-FR-009-1 | Dashboard harian menampilkan kunjungan, pendapatan, antrean aktif, dan status SATUSEHAT untuk hari berjalan. |

## DOC & NTF

| AC ID | Kriteria |
|---|---|
| AC-DOC-FR-001-1 | Semua dokumen cetak memakai kop & logo tenant yang aktif. |
| AC-DOC-FR-002-1 | Mengunduh ulang dokumen yang sudah diterbitkan menghasilkan isi identik (berkas tersimpan, bukan dibuat ulang). |
| AC-DOC-FR-003-1 | Berkas unggahan (PDF/JPG/PNG, maks. 10 MB) tersimpan di rekam pasien dan diakses via tautan berbatas waktu. |
| AC-NTF-FR-001-1 | Email undangan & reset password terkirim dalam ≤ 1 menit dan tidak memuat data medis. |
