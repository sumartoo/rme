# Threat Model — ClinicRME SaaS

| | |
|---|---|
| Versi | 0.1 — DRAFT (Stage 3) |
| Tanggal | 4 November 2026 |
| Metode | STRIDE per elemen data-flow + penilaian risiko (Dampak × Kemungkinan, 1–5) |
| Ruang lingkup | Arsitektur MVP (SYSTEM_ARCHITECTURE v1.0); aplikasi Android dinilai ulang di Stage 13 |

## 1. Aset

| ID | Aset | Klasifikasi | Dampak bila bocor/rusak |
|---|---|---|---|
| A1 | Rekam medis (SOAP, diagnosis, resep, hasil lab, dokumen) | Data pribadi spesifik (kesehatan) | Sangat tinggi — hukum, reputasi, keselamatan pasien |
| A2 | Identitas pasien (NIK, nama, tgl lahir, alamat, telepon) | Data pribadi | Tinggi |
| A3 | Kredensial & sesi staf | Rahasia | Tinggi — pintu ke A1 |
| A4 | Transaksi keuangan (invoice, pembayaran, refund) | Rahasia bisnis | Tinggi — fraud |
| A5 | Stok obat, termasuk narkotika/psikotropika | Rahasia bisnis, diatur | Tinggi — penyalahgunaan obat |
| A6 | Audit log | Integritas kritis | Tinggi — bukti hukum |
| A7 | Kredensial integrasi (SATUSEHAT, gateway, OAuth Google) | Rahasia | Tinggi |
| A8 | Kunci enkripsi & HMAC NIK | Rahasia | Sangat tinggi |
| A9 | Ketersediaan layanan pada jam praktik | Operasional | Tinggi — pelayanan terganggu |

## 2. Aktor Ancaman

| Aktor | Motivasi | Kemampuan |
|---|---|---|
| Penyerang eksternal | Data untuk dijual / ransom | Credential stuffing, phishing, eksploitasi web, bot |
| Staf klinik usil (insider) | Penasaran, balas dendam, keuntungan | Akun sah dengan sebagian permission |
| Staf klinik curang | Fraud kas, pencurian obat | Akun kasir/farmasi |
| Tenant lain (pengguna sah) | Melihat data klinik pesaing | Akun sah di tenant berbeda, memanipulasi ID di request |
| Staf platform / developer | Penyalahgunaan akses | Akses infrastruktur |
| Pihak ketiga terkompromi | — | Library, vendor integrasi, payment gateway palsu |

## 3. Batas Kepercayaan

```
[Internet] ──TB1── [Load Balancer + Cloud Armor] ──TB2── [Cloud Run: web / api]
                                                              │ TB3 (VPC privat)
                                                       [Cloud SQL] [GCS] [Secret Manager]
[api/worker] ──TB4── [SATUSEHAT | Lab | Payment gateway | Google | Email]
[Konsol platform] ──TB5── role DB terpisah tanpa akses data klinis
```

## 4. Analisis STRIDE

Skor: **D** dampak, **K** kemungkinan sebelum kontrol, **R** = D×K. Kontrol mengacu ke [SECURITY_CONTROLS.md](SECURITY_CONTROLS.md).

| ID | STRIDE | Ancaman | Aset | D | K | R | Kontrol | Sisa |
|---|---|---|---|---|---|---|---|---|
| T-01 | Info disclosure | Tenant A membaca data tenant B dengan mengganti ID di URL | A1, A2 | 5 | 4 | **20** | SC-TEN-01..05 (RLS fail-closed, FK komposit, 404, test otomatis) | Rendah |
| T-02 | Info disclosure | Developer lupa filter tenant pada query baru | A1 | 5 | 4 | **20** | SC-TEN-02/03 (RLS di DB, T06 cek katalog di CI) | Rendah |
| T-03 | Spoofing | Credential stuffing / brute force password | A3 | 4 | 4 | **16** | SC-AUTH-03/04 (lockout, rate limit, Argon2id), Google login | Rendah |
| T-04 | Spoofing | Phishing akun admin klinik | A3 | 5 | 3 | **15** | SC-AUTH-05 (MFA TOTP wajib admin), undangan wajib | Sedang |
| T-05 | Spoofing | Akun Google mantan staf masih bisa login | A3 | 4 | 3 | 12 | SC-AUTH-02/07 (tautan sub + nonaktif mencabut sesi) | Rendah |
| T-06 | Tampering | Mengubah rekam medis yang sudah disahkan | A1 | 5 | 3 | **15** | SC-INT-01 (trigger immutability, addendum, content hash) | Rendah |
| T-07 | Repudiation | Dokter menyangkal mengesahkan / staf menyangkal membuka RM | A1, A6 | 4 | 3 | 12 | SC-AUD-01..04 (audit tulis & baca, hash chain) | Rendah |
| T-08 | Tampering | Menghapus/mengubah audit untuk menutupi jejak | A6 | 5 | 2 | 10 | SC-AUD-02/03 (append-only, SECURITY DEFINER, verifikasi chain harian) | Rendah |
| T-09 | Elevation | Staf memanggil endpoint di luar perannya langsung via API | A1, A4 | 4 | 4 | **16** | SC-AUTHZ-01..03 (guard permission global, deny by default, test matriks) | Rendah |
| T-10 | Info disclosure | Staf membuka RM pasien yang tidak ditanganinya (snooping) | A1 | 4 | 4 | **16** | SC-AUD-01 (audit baca), laporan akses, kebijakan sanksi klinik; pembatasan cabang | Sedang — sisa risiko organisasional |
| T-11 | Tampering | Kasir membuat refund/void fiktif | A4 | 4 | 3 | 12 | SC-FIN-01..03 (maker–checker, laporan anomali, closing shift) | Rendah |
| T-12 | Spoofing | Callback QRIS palsu menandai invoice lunas | A4 | 4 | 3 | 12 | SC-FIN-04 (verifikasi signature, cek nominal, idempotency, rekonsiliasi) | Rendah |
| T-13 | Tampering | Pengeluaran obat keras/narkotika tanpa resep | A5 | 4 | 3 | 12 | SC-INT-03 (trigger golongan obat, permission khusus, laporan) | Rendah |
| T-14 | Info disclosure | Ekspor data massal oleh akun terkompromi | A1, A2 | 5 | 3 | **15** | SC-DATA-04 (permission export, watermark, batas baris, audit, alert volume) | Sedang |
| T-15 | Info disclosure | PHI bocor lewat log / error / notifikasi | A1, A2 | 4 | 3 | 12 | SC-LOG-01/02 (masking, tanpa PHI di log & notifikasi) | Rendah |
| T-16 | Info disclosure | Signed URL dokumen tersebar | A1 | 4 | 2 | 8 | SC-DATA-03 (TTL ≤ 5 menit, terbit setelah cek permission) | Rendah |
| T-17 | Info disclosure | Kebocoran database / backup | A1, A2, A8 | 5 | 2 | 10 | SC-CRY-01..03 (enkripsi at rest, NIK terenkripsi aplikasi, kunci di KMS, IAM) | Rendah |
| T-18 | Elevation | Staf platform membaca data klinis tenant | A1 | 5 | 2 | 10 | SC-TEN-06 (role platform tanpa grant klinis, break-glass teraudit) | Rendah |
| T-19 | Spoofing | Pencurian cookie sesi (XSS) | A3 | 4 | 3 | 12 | SC-WEB-01..03 (HttpOnly, CSP, escaping React, SameSite) | Rendah |
| T-20 | Tampering | CSRF pada aksi berisiko | A1, A4 | 4 | 2 | 8 | SC-WEB-02 (SameSite=Lax + header CSRF untuk metode non-GET) | Rendah |
| T-21 | Tampering | SQL injection | Semua | 5 | 2 | 10 | SC-WEB-04 (query terparameter Drizzle, larangan SQL mentah dari input) | Rendah |
| T-22 | DoS | Banjir request / bot | A9 | 3 | 3 | 9 | SC-NET-01/02 (Cloud Armor, rate limit, max instance) | Rendah |
| T-23 | DoS | Laporan berat mengunci DB | A9 | 3 | 3 | 9 | SC-DATA-05 (statement_timeout, asinkron, replica) | Rendah |
| T-24 | Tampering | Dependency berbahaya (supply chain) | Semua | 5 | 2 | 10 | SC-SDLC-02/03 (lockfile, scanning, review dependency) | Sedang |
| T-25 | Info disclosure | Secret ter-commit ke repository | A7, A8 | 5 | 3 | **15** | SC-SDLC-04 (secret scanning pre-commit & CI, Secret Manager) | Rendah |
| T-26 | Spoofing | Token SATUSEHAT/gateway dicuri dari worker | A7 | 4 | 2 | 8 | SC-CRY-04 (Secret Manager, SA per layanan, tanpa secret di env image) | Rendah |
| T-27 | Info disclosure | Pengunggahan berkas berbahaya (malware) ke rekam pasien | A1 | 3 | 3 | 9 | SC-DATA-06 (validasi tipe/ukuran, pemindaian malware OD-066) | Sedang |
| T-28 | Tampering | Race condition: dispensing ganda / pembayaran ganda | A4, A5 | 3 | 3 | 9 | SC-INT-02 (idempotency key, CHECK stok, unique constraint) | Rendah |

**Risiko tinggi (R ≥ 15) sebelum kontrol:** T-01, T-02, T-03, T-04, T-06, T-09, T-10, T-14, T-25. Semuanya memiliki kontrol; T-04, T-10, T-14 masih "Sedang" setelah kontrol dan dipantau.

## 5. Asumsi & Di Luar Cakupan

- Keamanan perangkat klinik (PC, jaringan Wi-Fi) tanggung jawab klinik; ClinicRME menyediakan panduan minimal (Stage 16 SOP).
- Ancaman negara/APT tingkat tinggi tidak dimodelkan secara khusus.
- Aplikasi Android dinilai ulang di Stage 13 (OWASP MASVS).

## 6. Pemeliharaan

Threat model ditinjau ulang setiap: penambahan integrasi baru, perubahan model autentikasi, perubahan arsitektur besar, dan minimal sekali per tahun.
