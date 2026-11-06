# Stage 8 — Stage Plan

| | |
|---|---|
| Stage | 8 — Registrasi Pasien, Jadwal & Antrean |
| Status | **BERJALAN** — batch 1–3 selesai; OD diputuskan (DEC-035) |
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
| **OD-012** ✅ DEC-035 | Provider notifikasi pengingat janji temu | **Ditunda** — SCH-FR-012 berstatus LJT. Stage 8 tidak mengirim pengingat; pilihan provider (WhatsApp Business API / SMS / email) diputuskan saat fitur itu dijadwalkan. Tidak ada biaya di Stage 8 |
| **OD-032** ✅ DEC-035 | Verifikasi eligibilitas asuransi: manual atau integrasi | **Manual di MVP**: saat check-in/walk-in dengan penjamin Asuransi/Perusahaan, petugas mencentang "eligibilitas sudah diverifikasi" + catatan (mis. nomor konfirmasi telepon), tercatat siapa & kapan. Polis kedaluwarsa memunculkan peringatan. Bila ditolak, pasien dialihkan ke Umum dengan persetujuan pasien (WF-03). Integrasi per asuransi dibahas setelah pilot |
| **OD-068** ✅ DEC-035 | Perilaku sistem saat pasien meminta pembatasan pemrosesan | Tanda `processing_restricted` pada pasien (diubah dengan alasan, teraudit). Akibatnya: tidak menerima pengingat/notifikasi non-wajib dan tidak ikut pemrosesan opsional (mis. portal, analitik yang menyebut identitas). **Tetap berjalan** karena kewajiban hukum/pelayanan: rekam medis, penagihan, dan pelaporan wajib (SATUSEHAT, Stage 12). Ini bukan nasihat hukum; perlu ditinjau PPDP (OD-069) sebelum pilot |
| **OD-085** ✅ DEC-035 | Data wajib saat registrasi pasien baru `[REVIEW-MEDIS]` | Wajib: nama lengkap, tanggal lahir, jenis kelamin, jenis identitas + nomornya (kecuali "tanpa identitas"), telepon **atau** kontak darurat, alamat. Opsional: wilayah (desa/kelurahan), email, golongan darah tidak di stage ini. Bayi baru lahir: wajib tautan ke pasien ibu. Daftar final dikonfirmasi tenaga medis klinik pilot |
| **OD-086** ✅ DEC-035 | Format nomor antrean & nomor kunjungan | **Antrean:** huruf awalan per poli (diatur di master poli, bawaan huruf pertama kode poli) + 3 digit, mulai 1 setiap hari per cabang × poli — contoh `A-001`. **Kunjungan:** per tenant `KJ{YYYY}{MM}{SEQ:6}` — contoh `KJ202611000123`; pola dapat diubah tenant admin seperti MRN |
| **OD-087** ✅ DEC-035 | Aturan terlambat & no-show (bawaan, dapat diubah per klinik) | Toleransi terlambat **15 menit** dari jam slot: masih dalam toleransi = antrean sesuai urutan janji; lewat toleransi = tetap check-in tetapi masuk antrean di belakang (seperti walk-in). **Auto no-show** untuk janji yang belum check-in saat sesi praktik dokter berakhir (dicek worker tiap 5 menit). Semua angka dapat diubah tenant admin |
| **OD-088** ✅ DEC-035 | Akses & isi layar TV antrean | TV tidak login sebagai user; tenant admin membuat **tautan layar** per cabang (token acak, dapat dicabut, hanya baca). Layar menampilkan nomor antrean, poli/ruang, dan status panggilan — **tanpa nama pasien** secara bawaan; klinik dapat memilih menampilkan inisial |
| **OD-089** ✅ DEC-035 | Teknologi pembaruan realtime layar TV & papan kerja | **Server-Sent Events (SSE)** + PostgreSQL `LISTEN/NOTIFY` — gratis, cukup untuk satu arah server → layar, berjalan melalui nginx. Catatan VPS: vhost nginx Bapak perlu `proxy_buffering off;` untuk lokasi SSE (instruksi diberikan saat batch 4) |
| **OD-090** ✅ DEC-035 | Model janji temu & kuota | Janji temu memakai **slot jam perkiraan** (mis. 08:00, 08:15 …) dari durasi slot di jadwal; kuota = jumlah slot. Walk-in **tidak** memakai kuota janji temu, tetapi petugas melihat peringatan bila total pasien sesi melebihi kuota |

## 5. Gate Stage 8

- [ ] Alur WF-01 s.d. WF-04 tahap pendaftaran teruji untuk setiap kategori pasien (Umum, Asuransi, Perusahaan)
- [ ] Uji konkurensi nomor antrean (tanpa duplikat) — 30 walk-in bersamaan di Q05 (batch 3); ratusan di batch 4
- [ ] Uji deteksi duplikat dengan dataset sintetis — dasar di P05 (batch 1); dataset sintetis lebih besar di batch 4
- [x] NIK tersimpan terenkripsi; pencarian via hash; NIK tidak muncul di log/audit — P01, P06, P07, P14, mutasi M26
- [ ] Matriks permission X01 mencakup semua endpoint baru
- [ ] Uji mutasi untuk kontrol baru hijau di GitHub Actions
- [ ] PO menyetujui Stage 8

## 6. Progres

| Tanggal | Isi | Bukti |
|---|---|---|
| 6 Nov 2026 | Stage 7 disetujui (DEC-034); rencana Stage 8 disusun, menunggu keputusan OD | — |
| 6 Nov 2026 | PO menyetujui semua usulan OD (DEC-035) | — |
| 6 Nov 2026 | **Batch 1 — master pasien (MPI):** modul `libs/patient`. API: cari (nama toleran salah ketik/trigram, NIK via indeks buta, No. RM, telepon dinormalkan +62→0, tanggal lahir; pasien yang digabung disembunyikan kecuali diminta), cek kandidat duplikat, registrasi (No. RM 8 digit per klinik + awalan opsional `mrnPrefix` — OD-081; NIK & nomor paspor/KITAS AES-256-GCM + indeks buta, hanya tersamar di respons; aturan data wajib OD-085; identitas sama → 409 dengan pasien yang ada; kandidat mirip → 409 kecuali petugas mengisi alasan yang tercatat di audit; **Idempotency-Key** wajib sehingga klik ganda tidak membuat pasien ganda), detail (akses tercatat READ dengan patient_id), ubah (If-Match, audit hanya kolom berubah, NIK `[rahasia]`, kontak menggantikan daftar), penjamin pasien (tambah, ubah/nonaktif dengan If-Match), consent berversi (teks tidak dapat diubah setelah terbit; catat & cabut tanpa menghapus), pembatasan pemrosesan (OD-068), gabung pasien (izin `patient.merge`; sumber MERGED tidak dihapus; NIK berbeda ditolak; NIK, penjamin aktif & kontak dipindah/disalin ke tujuan). Migrasi 0015: kolom tersamar & indeks buta identitas, pembatasan, jejak gabung, versi penjamin, tabel `idempotency_record` (RLS), DELETE pasien/penjamin/consent & UPDATE teks consent dicabut dari role aplikasi, menu Pelayanan → Pasien & Dokumen consent. Helper validasi/If-Match/audit dipindah dari masterdata ke `libs/shared` & `libs/db` agar dipakai lintas modul. UI: Pasien (cari), Daftar pasien baru (panel kandidat duplikat), detail pasien (identitas, kontak, penjamin, consent, pembatasan, gabung), Pengaturan klinik → Dokumen consent, awalan No. RM di Profil klinik. Kontrak +6 operasi | P01–P15, W17–W18, mutasi M23–M26 |
| 6 Nov 2026 | **Batch 2 — jadwal dokter & janji temu:** modul baru `libs/scheduling`. Jadwal praktik mingguan per dokter × cabang × poli (jam lokal cabang, durasi slot 5–120 menit, kuota bawaan = jumlah slot dan tidak boleh melebihinya — OD-090); satu dokter tidak dapat punya sesi tumpang tindih di cabang mana pun (exclusion constraint); perubahan jadwal (If-Match, audit hanya yang berubah) ditolak bila janji temu mendatang tidak lagi masuk jadwal/kuota. Cuti dokter / libur cabang per tanggal: slot ditutup, janji temu yang terdampak ditampilkan untuk dijadwalkan ulang, dapat dihapus. Slot per tanggal per sesi (terisi/tersedia, kuota, alasan tutup) sebagai waktu ber-zona. Janji temu: pesan (Idempotency-Key; baris jadwal dikunci sehingga kuota & slot aman saat bersamaan; indeks unik slot dokter & jam pasien sebagai pengaman), satu janji per pasien per dokter per hari, batal & jadwal ulang wajib alasan (janji lama RESCHEDULED → janji baru; gagal = tidak berubah), daftar per tanggal & riwayat pasien. Job worker `scheduling.no_show` tiap 5 menit: janji belum check-in saat sesi berakhir → NO_SHOW, teraudit sebagai SYSTEM (OD-087). Pengaturan klinik `lateToleranceMinutes` (bawaan 15) disiapkan untuk check-in batch 3. Migrasi 0016 (DELETE jadwal & janji temu dicabut dari role aplikasi; menu Janji temu & Jadwal dokter). UI: Jadwal dokter (jadwal mingguan, cuti/libur), Janji temu (per tanggal, buat dengan pemilih slot, jadwal ulang, batal) | S01–S11, W19, mutasi M27–M31 |
| 6 Nov 2026 | **Batch 3 — kunjungan & antrean:** walk-in dan check-in janji temu (hanya hari ini) membuat kunjungan + tiket antrean dalam satu transaksi; nomor kunjungan `KJ{YYYY}{MM}{SEQ:6}` & nomor antrean `<awalan>-001` per cabang × poli × hari lokal dari counter atomik (OD-086; awalan diatur di master poli, bawaan huruf pertama kode); satu kunjungan aktif per pasien per poli per hari; penjamin Asuransi/Perusahaan/BPJS wajib catatan verifikasi kepesertaan oleh petugas, tercatat siapa & kapan (OD-032); penjamin kedaluwarsa ditolak. Urutan layanan terpisah dari nomor: walk-in & terlambat = waktu datang, janji tepat waktu (toleransi `lateToleranceMinutes`, bawaan 15) = jam slot (OD-087). Peringatan bila dokter tidak berjadwal hari ini atau total pasien melampaui kuota sesi (OD-090). Antrean: daftar per poli, panggil berikutnya (SKIP LOCKED — dua petugas tidak memanggil tiket yang sama), panggil/panggil ulang, lewati; teraudit; sinyal `pg_notify` untuk layar TV batch 4. Papan kunjungan hari ini & riwayat kunjungan pasien; batal kunjungan wajib alasan (tiket & janji temu ikut batal). Migrasi 0017 (DELETE kunjungan/tiket/counter dicabut; menu Kunjungan & Antrean). UI: Kunjungan (walk-in, check-in, batal), Antrean (panggil), riwayat kunjungan di detail pasien, awalan antrean di master poli | Q01–Q09, W20, mutasi M32–M35 |
| 6 Nov 2026 | Kuota GitHub Actions AtoAIs habis (batch 2 ter-merge tetapi belum ter-deploy). **DEC-036:** verifikasi lokal lengkap sebagai pengganti CI sampai 1 Des; workflow dihemat. Batch 3 di-merge dengan bukti lokal: integrasi 176/176, E2E 30/30, mutasi M32–M35 terdeteksi, gitleaks bersih | DEC-036 |
