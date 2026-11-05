# Stage 8 — Stage Plan

| | |
|---|---|
| Stage | 8 — Registrasi Pasien, Jadwal & Antrean |
| Status | **RENCANA — menunggu keputusan OD dari PO** |
| Mulai | 6 November 2026 (DEC-034) |
| Project Owner | Sumarto |
| Requirement | **MVP saja** (DEC-010): REG-FR-001–009, 012 · SCH-FR-001–003, 005–008, 010, 011, 013 (tahap pendaftaran sampai Hadir). Di luar stage ini: REG-FR-010 cetak kartu (LJT), REG-FR-011 lookup IHS (Stage 12, kolom `ihs_status` tetap `PENDING`), SCH-FR-004 appointment via Android (Stage 13), SCH-FR-009 suara panggilan (LJT), SCH-FR-012 pengingat (LJT, OD-012) |
| Lingkungan uji | VPS dev `demo.medika.atoai.id` (CR-0003), deploy otomatis dari `main` |

## 1. Tujuan

Petugas pendaftaran dapat menemukan atau mendaftarkan pasien tanpa membuat data ganda, membuat janji temu pada jadwal dokter, mendaftarkan pasien walk-in, dan memberi nomor antrean yang tidak pernah ganda walau banyak loket mendaftar bersamaan. Perawat dan dokter memanggil antrean, dan layar TV di ruang tunggu menampilkan panggilan secara langsung.

## 2. Yang Sudah Ada

- **Skema** (baseline Stage 3): `patient` (NIK terenkripsi + hash, jenis identitas alternatif, `merged_into_id`, indeks trigram nama), `patient_contact`, `patient_coverage`, `consent_document`, `patient_consent`, `practitioner_schedule`, `schedule_exception`, `appointment`, `encounter`, `queue_ticket`, `queue_counter`, `document_sequence` + `app.next_document_number()`. Semua ber-RLS.
- **Izin** `patient.*`, `schedule.*`, `appointment.*`, `encounter.*`, `queue.call`, `queue.display` sudah ada di role template (migrasi 0001).
- **Kontrak** (`api/openapi.yaml`) sudah memuat 24 operasi rancangan Stage 8 (`patientCreate`, `patientDuplicateCheck`, `encounterWalkIn`, `appointmentCheckIn`, `queueCall`, dst.); akan disesuaikan bila keputusan OD mengubahnya.
- **Data master** dari Stage 7: cabang (zona waktu), poli/unit, tenaga kesehatan (SIP), penjamin + kontrak, wilayah, format MRN (OD-081).
- **Pola** NIK = AES-256-GCM + indeks buta HMAC (Stage 7), If-Match, audit before/after, impor dry-run.

## 3. Batch

| Batch | Isi | Requirement |
|---|---|---|
| **1 — Master pasien (MPI)** | API + UI pendaftaran pasien: daftar baru dengan MRN otomatis (OD-081), identitas tanpa NIK (paspor, KITAS, bayi dengan identitas ibu, tanpa identitas), cari pasien (nama toleran salah ketik, NIK, MRN, telepon, tanggal lahir), **peringatan kandidat duplikat sebelum simpan** (NIK sama = pasti; nama mirip + tanggal lahir + jenis kelamin = kandidat; lanjut membuat baru wajib alasan), ubah data (If-Match, audit), kontak darurat & wali, penjamin pasien (banyak, dengan masa berlaku), consent umum berversi, gabung pasien (izin `patient.merge`, data tidak dihapus, teraudit), tanda pembatasan pemrosesan (OD-068). NIK tidak pernah muncul di log/audit dalam bentuk asli | REG-FR-001–009, 012 |
| **2 — Jadwal dokter & janji temu** | Jadwal praktik mingguan per dokter × cabang × poli (jam, durasi slot, kuota), pengecualian (cuti dokter, libur cabang), daftar slot tersedia per tanggal (menghormati zona waktu cabang), buat janji temu, batal & jadwal ulang wajib alasan, auto no-show oleh worker sesuai pengaturan klinik (OD-087) | SCH-FR-001–003, 010, 011 |
| **3 — Kunjungan & antrean** | Walk-in → kunjungan + nomor antrean dalam satu transaksi; check-in janji temu → Hadir + nomor antrean (aturan terlambat OD-087); nomor kunjungan (`document_sequence` ENCOUNTER) dan nomor antrean atomik per cabang/poli/hari (OD-086); panggil, lewati, panggil ulang; papan kerja status kunjungan (Terdaftar → Hadir, tahap berikutnya diisi stage 9–11); batal kunjungan dengan alasan; riwayat kunjungan pasien; verifikasi penjamin manual saat check-in (OD-032) | SCH-FR-005–008, 013; WF-01–04 tahap pendaftaran |
| **4 — Layar TV & gate** | Layar TV antrean per cabang (realtime, OD-088/089), uji konkurensi nomor antrean (ratusan pendaftaran paralel, nol duplikat), uji deteksi duplikat dengan dataset sintetis, E2E WF-01–04 per kategori pasien (Umum, Asuransi, Perusahaan), uji mutasi baru, completion report | Gate §5 |

Perkiraan: ±1 hari kerja per batch, di luar waktu tunggu keputusan.

## 4. Open Decision Stage 8

| OD | Pertanyaan | Usulan |
|---|---|---|
| **OD-012** | Provider notifikasi pengingat janji temu | **Ditunda** — SCH-FR-012 berstatus LJT. Stage 8 tidak mengirim pengingat; pilihan provider (WhatsApp Business API / SMS / email) diputuskan saat fitur itu dijadwalkan. Tidak ada biaya di Stage 8 |
| **OD-032** | Verifikasi eligibilitas asuransi: manual atau integrasi | **Manual di MVP**: saat check-in/walk-in dengan penjamin Asuransi/Perusahaan, petugas mencentang "eligibilitas sudah diverifikasi" + catatan (mis. nomor konfirmasi telepon), tercatat siapa & kapan. Polis kedaluwarsa memunculkan peringatan. Bila ditolak, pasien dialihkan ke Umum dengan persetujuan pasien (WF-03). Integrasi per asuransi dibahas setelah pilot |
| **OD-068** | Perilaku sistem saat pasien meminta pembatasan pemrosesan | Tanda `processing_restricted` pada pasien (diubah dengan alasan, teraudit). Akibatnya: tidak menerima pengingat/notifikasi non-wajib dan tidak ikut pemrosesan opsional (mis. portal, analitik yang menyebut identitas). **Tetap berjalan** karena kewajiban hukum/pelayanan: rekam medis, penagihan, dan pelaporan wajib (SATUSEHAT, Stage 12). Ini bukan nasihat hukum; perlu ditinjau PPDP (OD-069) sebelum pilot |
| **OD-085** *(baru)* | Data wajib saat registrasi pasien baru `[REVIEW-MEDIS]` | Wajib: nama lengkap, tanggal lahir, jenis kelamin, jenis identitas + nomornya (kecuali "tanpa identitas"), telepon **atau** kontak darurat, alamat. Opsional: wilayah (desa/kelurahan), email, golongan darah tidak di stage ini. Bayi baru lahir: wajib tautan ke pasien ibu. Daftar final dikonfirmasi tenaga medis klinik pilot |
| **OD-086** *(baru)* | Format nomor antrean & nomor kunjungan | **Antrean:** huruf awalan per poli (diatur di master poli, bawaan huruf pertama kode poli) + 3 digit, mulai 1 setiap hari per cabang × poli — contoh `A-001`. **Kunjungan:** per tenant `KJ{YYYY}{MM}{SEQ:6}` — contoh `KJ202611000123`; pola dapat diubah tenant admin seperti MRN |
| **OD-087** *(baru)* | Aturan terlambat & no-show (bawaan, dapat diubah per klinik) | Toleransi terlambat **15 menit** dari jam slot: masih dalam toleransi = antrean sesuai urutan janji; lewat toleransi = tetap check-in tetapi masuk antrean di belakang (seperti walk-in). **Auto no-show** untuk janji yang belum check-in saat sesi praktik dokter berakhir (dicek worker tiap 5 menit). Semua angka dapat diubah tenant admin |
| **OD-088** *(baru)* | Akses & isi layar TV antrean | TV tidak login sebagai user; tenant admin membuat **tautan layar** per cabang (token acak, dapat dicabut, hanya baca). Layar menampilkan nomor antrean, poli/ruang, dan status panggilan — **tanpa nama pasien** secara bawaan; klinik dapat memilih menampilkan inisial |
| **OD-089** *(baru)* | Teknologi pembaruan realtime layar TV & papan kerja | **Server-Sent Events (SSE)** + PostgreSQL `LISTEN/NOTIFY` — gratis, cukup untuk satu arah server → layar, berjalan melalui nginx. Catatan VPS: vhost nginx Bapak perlu `proxy_buffering off;` untuk lokasi SSE (instruksi diberikan saat batch 4) |
| **OD-090** *(baru)* | Model janji temu & kuota | Janji temu memakai **slot jam perkiraan** (mis. 08:00, 08:15 …) dari durasi slot di jadwal; kuota = jumlah slot. Walk-in **tidak** memakai kuota janji temu, tetapi petugas melihat peringatan bila total pasien sesi melebihi kuota |

## 5. Gate Stage 8

- [ ] Alur WF-01 s.d. WF-04 tahap pendaftaran teruji untuk setiap kategori pasien (Umum, Asuransi, Perusahaan)
- [ ] Uji konkurensi nomor antrean (tanpa duplikat)
- [ ] Uji deteksi duplikat dengan dataset sintetis
- [ ] NIK tersimpan terenkripsi; pencarian via hash; NIK tidak muncul di log/audit
- [ ] Matriks permission X01 mencakup semua endpoint baru
- [ ] Uji mutasi untuk kontrol baru hijau di GitHub Actions
- [ ] PO menyetujui Stage 8

## 6. Progres

| Tanggal | Isi | Bukti |
|---|---|---|
| 6 Nov 2026 | Stage 7 disetujui (DEC-034); rencana Stage 8 disusun, menunggu keputusan OD | — |
