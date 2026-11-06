# Stage 8 — Stage Completion Report

| | |
|---|---|
| Stage | 8 — Registrasi Pasien, Jadwal & Antrean |
| Status | **MENUNGGU PERSETUJUAN PO** |
| Disusun oleh | Sumarto (dibantu Claude) |
| Rincian | [STAGE_PLAN.md](STAGE_PLAN.md) §6 · keputusan DEC-035, DEC-036 |
| Mode verifikasi | **Lokal** (DEC-036): kuota GitHub Actions habis 6 Nov. Semua uji di bawah dijalankan di workspace; CI, SAST, audit dependensi, build image, dan deploy ke VPS menyusul saat Actions aktif lagi (1 Des 2026) |
| Lingkungan uji | `https://demo.medika.atoai.id` masih menjalankan batch 1; batch 2–4 ter-deploy otomatis setelah CI pertama di `main` hijau |

## 1. Ringkasan

Petugas pendaftaran kini bisa:
- mencari pasien (toleran salah ketik) dan mendaftarkan pasien baru tanpa membuat data ganda;
- mengelola penjamin, consent berversi, dan menggabungkan data ganda;
- membuat janji temu pada slot jadwal dokter, menjadwalkan ulang, dan membatalkan;
- mendaftarkan walk-in atau check-in janji temu, yang langsung menghasilkan nomor kunjungan dan nomor antrean.

Perawat/dokter memanggil antrean, dan layar TV ruang tunggu memperbaruinya secara langsung tanpa menampilkan nama pasien.

| Metrik | Nilai |
|---|---|
| Uji integrasi API | 183/183 (P01–P15, S01–S11, Q01–Q09, D01–D04, G01–G03 baru) |
| Uji matriks permission (X01) | otomatis mencakup semua operasi baru (198 operasi di kontrak) |
| E2E browser | 31/31 (W17–W21 baru) |
| Uji mutasi baru | M23–M38, semua terdeteksi lokal; run lengkap M1–M38 di Actions menunggu kuota (§3) |
| Migrasi | 0015–0018 |
| Modul baru | `libs/patient`, `libs/scheduling` |

## 2. Requirement MVP

| ID | Status | Bukti |
|---|---|---|
| REG-FR-001 registrasi pasien, No. RM otomatis | ✅ 8 digit per klinik + awalan opsional (OD-081); Idempotency-Key mencegah klik ganda | P01–P03, P13, W17 |
| REG-FR-002 identitas tanpa NIK (paspor, KITAS, bayi, tanpa identitas) | ✅ bayi wajib tautan ibu | P03–P04 |
| REG-FR-003 pencarian pasien | ✅ nama (trigram), NIK (indeks buta), No. RM, telepon, tanggal lahir | P06, W17 |
| REG-FR-004 peringatan kandidat duplikat | ✅ identitas sama ditolak; nama mirip wajib alasan teraudit | P05, G02, W17 |
| REG-FR-005 ubah data teraudit | ✅ If-Match, audit hanya kolom berubah, NIK `[rahasia]`; akses detail tercatat READ | P07, P11 |
| REG-FR-006 kontak darurat & wali | ✅ | P03, P07, W17 |
| REG-FR-007 penjamin pasien | ✅ banyak, masa berlaku, versi | P08, W17 |
| REG-FR-008 consent umum berversi | ✅ teks tidak dapat diubah setelah terbit; cabut tanpa hapus | P09, W18 |
| REG-FR-009 gabung pasien | ✅ izin `patient.merge`, sumber tidak dihapus, teraudit | P12, W18 |
| REG-FR-012 pembatasan pemrosesan | ✅ tanda + alasan (OD-068); perlu tinjauan PPDP (OD-069) sebelum pilot | P10 |
| SCH-FR-001/002 jadwal praktik & pengecualian | ✅ tanpa tumpang tindih (exclusion constraint); cuti/libur menutup slot | S01–S02, S08–S09, W19 |
| SCH-FR-003 janji temu berbasis slot | ✅ kuota aman saat bersamaan (OD-090) | S03–S05, W19 |
| SCH-FR-005/006 walk-in & check-in → nomor antrean | ✅ satu transaksi; aturan terlambat (OD-087) | Q01–Q05, Q09, W20 |
| SCH-FR-007 panggil / lewati / panggil ulang | ✅ SKIP LOCKED, teraudit | Q06, W20 |
| SCH-FR-008 layar TV antrean | ✅ tautan token, SSE, tanpa nama (OD-088/089) | D01–D04, W21 |
| SCH-FR-010/011 batal & jadwal ulang, no-show otomatis | ✅ wajib alasan; worker tiap 5 menit | S06–S07, S11, Q07 |
| SCH-FR-013 papan status kunjungan | ✅ sampai Hadir; tahap berikutnya di Stage 9–11 | Q08, W20 |

## 3. Checklist Gate

- [x] Alur WF-01 s.d. WF-04 tahap pendaftaran untuk setiap kategori pasien (Umum, Asuransi, Asuransi ditolak → Umum, Perusahaan) — G03, W20
- [x] Uji konkurensi nomor antrean: 200 walk-in bersamaan di 2 poli → nomor 1..100 per poli, nol duplikat — G01 (dan Q05)
- [x] Uji deteksi duplikat dengan dataset sintetis deterministik: 60/60 varian salah ketik ditemukan, 1/60 positif palsu (batas ≤ 6), 20/20 NIK sama ditolak — G02
- [x] NIK terenkripsi; pencarian via indeks buta; NIK tidak muncul di log/audit — P01, P06, P07, P14, mutasi M26; isolasi antarklinik P15
- [x] Matriks permission X01 mencakup semua endpoint baru
- [ ] Uji mutasi hijau di GitHub Actions. M23–M38 sudah terdeteksi lokal satu per satu (DEC-036). Run lengkap M1–M38 dijalankan manual di Actions setelah kuota aktif 1 Des; dicatat sebagai **syarat terbuka S8-1**
- [ ] PO menyetujui Stage 8

## 4. Keamanan & privasi

- NIK, nomor paspor, dan KITAS disimpan dengan AES-256-GCM dan dicari lewat indeks buta HMAC. Respons hanya memuat versi tersamar.
- DELETE pada pasien, penjamin, consent, jadwal, janji temu, kunjungan, dan tiket antrean dicabut dari role aplikasi di level database.
- Layar TV tidak login. Token 256-bit hanya disimpan sebagai sha256, ditampilkan sekali, dan bisa dicabut. Layar yang sudah terbuka berhenti dalam ≤ 60 detik setelah dicabut. Token klinik lain ditolak (RLS + host tenant).
- Data layar hanya berisi nomor antrean, poli, dan nama dokter. Inisial pasien hanya muncul bila klinik mengaktifkannya; nama lengkap dan No. RM tidak pernah dikirim (D02, mutasi M37).
- Sinyal `pg_notify` hanya membawa ID tenant dan cabang, tanpa data pasien.
- Dependency baru: tidak ada. `pg` sudah dipakai di monorepo dan kini juga dideklarasikan di `libs/scheduling`.
- Tertunda karena DEC-036: Semgrep dan `pnpm audit` di CI. Keduanya dijalankan di CI pertama setelah 1 Des.

## 5. Catatan untuk VPS & Stage berikutnya

- **nginx & SSE:** respons stream mengirim `X-Accel-Buffering: no`, jadi vhost tidak perlu diubah. Bila layar TV hanya ter-update saat dimuat ulang, tambahkan `proxy_buffering off;` pada lokasi `/api/v1/public/queue-display/`.
- **Setelah 1 Des:** CI di `main` harus hijau (deploy batch 2–4, migrasi 0016–0018), lalu cek `healthz`, lalu run manual uji mutasi lengkap (S8-1).
- Teks consent contoh dan daftar data wajib OD-085 perlu ditinjau tenaga medis klinik pilot `[REVIEW-MEDIS]`.
- Pengingat janji temu (OD-012) dan suara panggilan tetap LJT.
- Tahap kunjungan setelah Hadir (perawat, dokter, farmasi, kasir) dikerjakan di Stage 9–11.
- Tetap terbuka dari Stage 7: S7-1 (lisensi & data ICD resmi).

## 6. Persetujuan

| Peran | Nama | Keputusan | Tanggal | Catatan |
|---|---|---|---|---|
| Project Owner | Sumarto | ☐ Disetujui ☐ Revisi | | |
