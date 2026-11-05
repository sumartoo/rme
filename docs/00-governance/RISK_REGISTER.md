# Risk Register — ClinicRME SaaS

| | |
|---|---|
| Versi | 0.1 |
| Tanggal | 3 November 2026 |
| Review | Setiap akhir stage |

**Skala:** Dampak (D) & Kemungkinan (K) 1–5. Skor = D × K. **≥ 15 Tinggi**, 8–14 Sedang, ≤ 7 Rendah.

| ID | Kategori | Risiko | D | K | Skor | Mitigasi | Pemilik | Stage | Status |
|---|---|---|---|---|---|---|---|---|---|
| RSK-001 | Keamanan | Kebocoran data antar tenant karena query tanpa filter tenant | 5 | 3 | **15** | RLS + `FORCE ROW LEVEL SECURITY`, helper `withTenantTx`, suite test isolasi otomatis di CI | Tech lead | 2–3 | Terbuka |
| RSK-002 | Integrasi | Spesifikasi / resource wajib SATUSEHAT berubah | 4 | 4 | **16** | Adapter & mapper terisolasi, pantau changelog SATUSEHAT, test kontrak di sandbox | Tech lead | 12 | Terbuka |
| RSK-003 | Scope | Scope creep ke fitur SIMRS (rawat inap, IGD) | 4 | 4 | **16** | Batas sistem tertulis di SCOPE.md, semua perubahan via CR | PO | Semua | Terbuka |
| RSK-004 | Integrasi | API aplikasi lab eksisting bervariasi atau tidak tersedia | 3 | 4 | 12 | Inventaris vendor di klinik pilot sejak Stage 1, adapter per vendor, fallback input hasil manual | Tech lead | 1, 9 | Terbuka |
| RSK-005 | Biaya | Biaya GCP melonjak (autoscaling, egress, log) | 3 | 3 | 9 | Max instance, budget alert, retensi log, review biaya bulanan | Tech lead | 15 | Terbuka |
| RSK-006 | Klinis | Validasi alur klinis, template, dan terminologi dilakukan oleh non-tenaga medis (PO merangkap clinical advisor) | 5 | 4 | **20** | Requirement klinis ditandai `[REVIEW-MEDIS]`; rekrut dokter/perekam medis untuk review berbayar/sukarela; review medis menjadi **syarat gate Stage 9**; manfaatkan klinik pilot sejak Stage 1 | PO | 1–9 | Terbuka |
| RSK-007 | Kepatuhan | Klaim kepatuhan tanpa bukti di materi pemasaran | 4 | 2 | 8 | Prinsip #9, review materi sebelum terbit | PO | Semua | Terbuka |
| RSK-008 | Kapasitas | Tim kecil vs 18 stage → jadwal mundur, kelelahan | 4 | 4 | **16** | Prioritas MVP (OD-061), estimasi per stage, otomasi test & deploy | PO | 0–1 | Terbuka |
| RSK-009 | Pasar | Tanpa bridging BPJS, produk kurang diminati klinik pratama FKTP | 4 | 3 | 12 | Putuskan OD-001; validasi dengan calon pelanggan | PO | 0 | Terbuka |
| RSK-010 | Regulasi | Kewajiban PP 33/2026 (berlaku 16 Jan 2027) — DPIA, PPDP, notifikasi kegagalan — belum siap saat produksi | 4 | 3 | 12 | Masukkan ke Stage 3; konsultasi hukum; DPA dengan klinik | PO | 3 | Terbuka |
| RSK-011 | Regulasi | Retensi RME ≥ 25 tahun → biaya penyimpanan jangka panjang & kewajiban saat tenant berhenti | 3 | 5 | **15** | Kebijakan arsip & serah terima data di kontrak, storage class berbiaya rendah, masuk model harga | PO | 3, 5 | Terbuka |
| RSK-012 | Keamanan | Penyalahgunaan akun (credential stuffing, akun staf yang keluar) | 4 | 3 | 12 | Lockout, MFA admin, undangan wajib, nonaktif mencabut sesi, audit login | Tech lead | 3, 6 | Terbuka |
| RSK-013 | Integritas | Rekam medis yang sudah disahkan berubah tanpa jejak | 5 | 2 | 10 | Trigger immutability, addendum, content hash, audit chain | Tech lead | 9 | Terbuka |
| RSK-014 | Keuangan | Fraud kasir: void/refund tidak sah, double payment | 4 | 3 | 12 | Maker–checker, idempotency, rekonsiliasi, aturan deteksi | Tech lead | 11 | Terbuka |
| RSK-015 | Ketersediaan | Gangguan internet di klinik menghentikan pelayanan | 4 | 3 | 12 | Prosedur downtime (formulir cadangan + input ulang), evaluasi mode offline terbatas di Stage 1 | PO | 1, 15 | Terbuka |
| RSK-016 | Pilot | Tidak ada klinik pilot yang bersedia | 4 | 3 | 12 | Rekrut sejak Stage 0–1, tawarkan insentif pilot | PO | 0 | Terbuka |
| RSK-017 | Teknologi | Ketergantungan ke ekosistem Node (library terhenti, celah dependency) | 3 | 3 | 9 | Batasi dependency, dependency scanning, pilih library matang | Tech lead | 4, 17 | Terbuka |
| RSK-018 | Lisensi | Penggunaan data ICD-10 / ICD-9-CM tanpa izin yang jelas | 3 | 3 | 9 | Tetapkan sumber resmi & izin (OD-030). Stage 7: data CONTOH berlabel, pemuat ber-versi siap; izin & data resmi = syarat S7-1 sebelum pilot (DEC-032) | PO | 16 | Terbuka |
| RSK-019 | Data | Kualitas data migrasi dari sistem lama klinik pilot buruk | 3 | 4 | 12 | Profiling data, dry-run migrasi, validasi oleh klinik | Tech lead | 16 | Terbuka |
| RSK-020 | Keamanan | Kontrol yang sudah terbukti di PoC Stage 3 hilang/melemah saat dipindah ke monorepo Stage 4 | 5 | 2 | 10 | Suite e2e PoC (E01–E32) dipindah utuh menjadi uji penerimaan wajib di CI Stage 4; uji mutasi M1–M4 diulang; gate Stage 4 mensyaratkan suite lulus | Tech lead | 4 | Terbuka — suite + M1–M5 terdeteksi di monorepo; workflow CI siap, aktif setelah repo GitHub dibuat |
| RSK-021 | Keamanan | Rantai pasok CI: GitHub Action / binary tool keamanan dikompromikan (kasus trivy-action Maret 2026) dan mencuri secret | 5 | 2 | 10 | Action dipin ke commit SHA, binary diunduh dengan verifikasi sha256, `GITHUB_TOKEN` read-only, workflow PR tanpa secret, Dependabot untuk pembaruan terkontrol; Trivy tidak dipakai (DEC-022) | Tech lead | 4, 15 | Terbuka |
| RSK-022 | Keamanan | Hak akses DB baru (partisi, tabel, fungsi) tidak tercakup aturan RLS/grant yang ada — pola temuan Stage 4 pada partisi audit | 5 | 2 | 10 | Uji katalog T25/T26g (tidak ada hak role aplikasi pada partisi), aturan CODING_STANDARDS §4, mutasi M5; fungsi baru wajib `REVOKE ... FROM PUBLIC`; Stage 5: T27 (role platform vs semua tabel ber-`tenant_id`), T30b/c (fungsi SECURITY DEFINER), mutasi M6 | Tech lead | 4+ | Terbuka |
| RSK-023 | Keamanan | Pengguna platform kehilangan perangkat TOTP; pemulihan saat ini hanya lewat database oleh admin platform lain (tidak ada alur resmi) — risiko terkunci atau pemulihan tanpa jejak | 3 | 3 | 9 | 8 recovery code sekali pakai; TOTP tidak bisa didaftar ulang hanya dengan password (P02); runbook pemulihan + aksi teraudit oleh admin kedua di Stage 15; minimal 2 PLATFORM_ADMIN sebelum pilot | Tech lead | 5, 15 | Terbuka |
| RSK-024 | Keamanan | Kode TOTP yang sama dapat dipakai ulang dalam periode 30 detiknya (klinik & konsol tidak menyimpan langkah TOTP terakhir) — penyadap/phishing real-time bisa memakai kode yang baru diketik pengguna | 3 | 2 | 6 | Password tetap wajib; 5 kode salah per sesi → sesi dicabut; sesi dirotasi saat MFA. **Diperbaiki Stage 6 batch 1:** `last_totp_step` per user (klinik & platform, migrasi 0007), langkah ≤ terakhir ditolak (E34, P20, mutasi M15) | Tech lead | 6 | Tertutup |

## Risiko Tinggi (skor ≥ 15)

RSK-006 (20), RSK-002, RSK-003, RSK-008 (16), RSK-001, RSK-011 (15) — dipantau setiap akhir stage. Pemilik semua risiko: Sumarto.
