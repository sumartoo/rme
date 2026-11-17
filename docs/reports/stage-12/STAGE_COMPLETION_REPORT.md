# Stage 12 — Stage Completion Report

| | |
|---|---|
| Stage | 12 — FHIR & SATUSEHAT Integration |
| Status | **DISETUJUI BERSYARAT** — DEC-045 (17 Nov 2026). Syarat sebelum pilot: validasi di sandbox SATUSEHAT dengan kredensial OD-058. Tindak lanjut: uji mutasi lengkap M1–M175 di Actions setelah 1 Des |
| Disusun oleh | Sumarto (dibantu Claude) |
| Rincian | [STAGE_PLAN.md](STAGE_PLAN.md) · keputusan DEC-044 (OD-009, OD-042, OD-058, OD-114–OD-122) · [SATUSEHAT_INTEGRATION.md](../../02-architecture/SATUSEHAT_INTEGRATION.md) · [FHIR_MAPPING.md](../../02-architecture/FHIR_MAPPING.md) |
| Repo kerja | `AtoAIs/atoai-rme-v2`, PR #41, #43, #45, #46. Kuota GitHub Actions AtoAIs habis sampai 1 Des 2026, jadi setiap batch diverifikasi penuh di lokal lalu digabung tanpa CI (DEC-036) |
| Lingkungan uji | **Simulator SATUSEHAT** bawaan (OD-121). Demo VPS belum diperbarui ke Stage 10–12 |

> **Batas klaim.** ClinicRME **belum** boleh disebut "terintegrasi" atau "compliant SATUSEHAT". Seluruh pengujian Stage 12 berjalan terhadap
> simulator. Status resmi baru dapat dinyatakan setelah validasi di sandbox resmi berhasil dan buktinya tersimpan.

## 1. Ringkasan

Klinik kini dapat mengirim data rawat jalan ke SATUSEHAT tanpa mengganggu pelayanan:

1. **Koneksi & identitas** (batch 1).
   - Kredensial disimpan per fasilitas, terenkripsi, dan tidak ditampilkan lagi. Setiap fasilitas memiliki uji koneksi.
   - Sinkron master mendaftarkan poli sebagai Location dan mencari IHS tenaga kesehatan dari NIK.
   - IHS pasien dicari otomatis tiap 10 menit, atau lewat tombol di halaman pasien.
2. **Kunjungan** (batch 2).
   - Setelah RM disahkan, satu Bundle dikirim: Encounter + Condition (ICD-10) + Observation (tanda vital, LOINC/UCUM) + Procedure (ICD-9-CM).
   - Data diperiksa dulu. Yang belum lengkap ditahan dengan pesan yang dapat ditindaklanjuti, lalu dicek ulang tiap putaran.
3. **Obat, retry & koreksi** (batch 3).
   - MedicationRequest dan MedicationDispense dikirim dengan kode KFA. Obat tanpa KFA ditahan dengan pesan "butuh kode KFA".
   - Addendum dapat mengganti diagnosis. SATUSEHAT menerima Condition baru, Condition lama ditandai entered-in-error, dan Encounter diperbarui.
   - Gangguan sementara dicoba ulang dengan backoff. Setelah 5 kali gagal, kiriman menjadi dead-letter, admin klinik menerima email, dan tersedia tombol kirim ulang manual yang teraudit.
4. **Pemantauan & rekonsiliasi** (batch 4).
   - Dashboard menampilkan jumlah per hari dan total per status.
   - Rekonsiliasi membandingkan kunjungan disahkan dengan yang terkirim, lengkap dengan selisih dan alasannya.
   - Job tiap jam mencocokkan setiap kunjungan terkirim dengan SATUSEHAT: Encounter yang hilang ditandai, ID yang belum diketahui diisi, dan data ganda dilaporkan.

| Metrik | Nilai |
|---|---|
| Uji integrasi API | 284/284 (baru: J01–J06, U01–U06, V01–V06, C16b, O01–O04) |
| Uji keamanan & migrasi SQL | lulus (`test:db`); paritas skema lulus |
| E2E browser | 48/48 (baru: W35–W38) |
| Uji mutasi baru | M134–M175, semua terdeteksi di lokal; M109/M122 (Stage 11) diperbaiki |
| Migrasi | 0031–0034 |
| Kontrak API | 263 operasi |
| Modul baru | `libs/integration` (API admin); `libs/db` subpath `satusehat`, `satusehat-encounter`, `satusehat-followup`, `satusehat-reconcile` |
| Job worker baru | `integration.satusehat_ihs_lookup` (10 menit), `integration.satusehat_send` (5 menit), `integration.satusehat_reconcile` (tiap jam); mode `WORKER_RUN_ONCE` |
| Dependency baru | tidak ada |

## 2. Requirement MVP

| ID | Status | Bukti |
|---|---|---|
| INT-FR-001 kredensial per fasilitas & uji koneksi | ✅ terenkripsi AES-256-GCM, satu koneksi aktif per fasilitas, simulator ditolak di produksi | J01, J02, W35 |
| INT-FR-002 Organization, Location, Practitioner | ✅ Location per poli (idempoten per identifier), IHS tenaga kesehatan dari NIK (OD-117) | J03, W35 |
| INT-FR-003 lookup IHS pasien | ✅ otomatis & manual; tanpa NIK / tidak ditemukan tidak memblokir pelayanan (OD-116) | J04–J06, W35 |
| INT-FR-004 Encounter, Condition, Observation, Procedure | ✅ satu Bundle transaction setelah RM disahkan (OD-115) | U01–U06, W36 |
| INT-FR-005 MedicationRequest & MedicationDispense | ✅ Medication contained berkode KFA; racikan per komponen (OD-118) | V01, V02 |
| INT-FR-008 validasi sebelum kirim | ✅ masalah yang memblokir + peringatan, pesan tanpa data pasien | U01, V01, V02 |
| INT-FR-009 retry, dead-letter, kirim ulang | ✅ backoff 1 m/5 m/30 m/2 j → DEAD + email; kirim ulang manual teraudit & idempoten (OD-119) | U04, U05, V03, V04, W37 |
| INT-FR-010 dashboard | ✅ per hari & total per status, antrean, data ganda | O01, W38 |
| INT-FR-011 rekonsiliasi | ✅ disahkan vs terkirim (selisih & alasan) + pencocokan jarak jauh | O02, O03, W38 |
| INT-FR-012 update saat addendum | ✅ addendum mengganti diagnosis (ikut di-hash) → POST/PUT Condition & PUT Encounter, riwayat versi (OD-120) | C16b, V05, V06, W37 |
| INT-FR-006/007 lab & Composition | LJT (OD-042) | — |

**Penyimpangan dan hal yang perlu Bapak ketahui:**
- **Belum ada validasi sandbox.** Butir gate pertama belum dapat dicentang tanpa kredensial OD-058. Langkah validasi dan bukti yang perlu disimpan ada di `SATUSEHAT_INTEGRATION.md` §8.
- **Pemetaan FHIR baru dicocokkan sekilas** dengan dokumentasi dan koleksi Postman resmi (17 Nov 2026), belum per elemen. Butir yang wajib dicek di sandbox tercantum di `FHIR_MAPPING.md` §11, di antaranya:
  - ekstensi jenis obat;
  - identifier penyerahan obat sebagian;
  - rute pemberian yang masih dikirim sebagai teks;
  - lokasi apotek;
  - parameter pencarian `encounter=`.
- **Data ganda tidak dihapus otomatis.** Sumber data ganda yang diketahui: respons hilang tepat setelah Condition baru hasil addendum tersimpan. Rekonsiliasi melaporkan jumlahnya, dan koreksi dilakukan manual setelah ditinjau.
- **Notifikasi in-app** tersedia sebagai daftar "Perlu tindakan" dan panel status di halaman kunjungan. Belum ada kotak notifikasi atau lonceng tersendiri.
- **Simulator hanya hidup di satu proses.** Karena itu E2E tidak menguji rekonsiliasi jarak jauh. Rekonsiliasi jarak jauh diuji di integrasi (O02–O03).

## 3. Checklist Gate

- [ ] Semua resource MVP tervalidasi di sandbox SATUSEHAT, bukti tersimpan — **menunggu OD-058** (disetujui bersyarat, OD-121)
- [x] Semua resource MVP lolos uji kontrak terhadap simulator: struktur, referensi, terminologi (U03, V01, V02, V05; unit simulator)
- [x] Uji idempotensi: event ganda & kirim ulang tidak membuat resource ganda (U04, V03, V04, O03; M145, M155)
- [x] Uji kegagalan jaringan, error validasi, token kedaluwarsa (U05, U06, V03; unit klien 401 → token baru; M147–M149)
- [x] Rekonsiliasi menunjukkan 0 selisih pada dataset uji (O02, W38; M167–M173)
- [x] Payload & kredensial tidak muncul di log/audit; kredensial terenkripsi (O04, J02)
- [x] Tidak ada klaim "SATUSEHAT compliant/terintegrasi resmi" — UI & dokumen menyebut "belum divalidasi sandbox"
- [x] Matriks permission X01 mencakup semua endpoint baru; uji mutasi kontrol baru terdeteksi (M134–M175)
- [ ] Uji mutasi lengkap M1–M175 di GitHub Actions — setelah kuota aktif 1 Des (bersama S8-1, S9-2, S10-2, Stage 11)
- [x] PO menyetujui Stage 12 — DEC-045 (bersyarat: validasi sandbox sebelum pilot)

## 4. Keamanan & privasi

- **Kredensial**:
  - Secret dienkripsi AES-256-GCM dengan kunci aplikasi dan tidak pernah dikembalikan API. Client ID hanya ditampilkan tersamar.
  - Token OAuth2 hanya disimpan di memori proses.
- **Tanpa payload di penyimpanan** (OD-122). `fhir_sync_record` menyimpan status, ID SATUSEHAT, hash SHA-256 payload, kode lokal, dan pesan error operasional.
  - Audit dan email hanya memuat jumlah dan nomor kunjungan, tanpa nama, NIK, IHS, atau isi rekam medis. Ini diuji di O04.
- **Pembatasan pemrosesan** oleh pasien membuat kunjungan, resep, dan koreksinya tidak dikirim (`SKIPPED`).
- **Izin akses**:

  | Izin | Mencakup |
  |---|---|
  | `integration.read` | lihat |
  | `integration.manage` | kredensial, sinkron master, kirim ulang |
  | `clinical.record.read` | status per kunjungan |

  Semua endpoint baru tercakup matriks X01.
- **Audit** mencatat:
  - simpan kredensial, uji koneksi, sinkron master, lookup IHS;
  - kunjungan/obat/koreksi terkirim, ditolak, dicoba ulang, dan dead-letter;
  - Encounter yang tidak ditemukan saat rekonsiliasi;
  - kirim ulang manual.
- **Addendum yang mengganti diagnosis** ikut di-hash, sehingga perubahan di luar aplikasi terdeteksi saat verifikasi (C16b). Diagnosis saat pengesahan tetap terkunci.

## 5. Yang perlu diputuskan atau ditindaklanjuti sebelum pilot

- **OD-058 — kredensial sandbox SATUSEHAT** (tindakan PO): daftar di portal developer, lalu isi langsung di halaman Integrasi. **Jangan kirim lewat chat.** Setelah itu validasi dijalankan sesuai §8 panduan.
- **S7-1 — data ICD-10 resmi**: diperlukan agar Condition lolos validasi sandbox.
- **OD-069 / OD-122 — konfirmasi PPDP** atas dasar pengiriman tanpa opt-out per pasien.
- **Kode KFA** di master obat klinik pilot perlu dilengkapi. Obat tanpa KFA akan selalu tertahan.
- **Kredensial produksi** per fasyankes diurus klinik pilot sendiri (Stage 16).
- Pengingat UAT yang sudah ada: S9-1 (review medis), S10-1 (review apoteker), penyedia QRIS, dan uji mutasi lengkap setelah 1 Des.

## 6. Catatan untuk Stage berikutnya

- **Stage 13 (Patient Portal):** belum ada data dari SATUSEHAT yang ditampilkan ke pasien.
- **Stage 14 (laporan):** dashboard SATUSEHAT dapat menjadi salah satu indikator kepatuhan operasional. Datanya di `fhir_sync_record`.
- **Stage 16 (pilot):** checklist go-live perlu memuat registrasi fasyankes di SATUSEHAT, kredensial produksi, Sinkron master, NIK tenaga kesehatan, dan kode KFA.
- **LJT:** lab (ServiceRequest/Specimen/DiagnosticReport), Composition/resume, AllergyIntolerance, KYC SATUSEHAT Mobile, bayi baru lahir & WNA, API FHIR publik (OD-009), serta koreksi data ganda otomatis.
- **Batasan yang diketahui:**

  | Bagian | Batas |
  |---|---|
  | Rekonsiliasi | rentang 92 hari, 500 baris |
  | Perlu tindakan | 200 data |
  | Dashboard | 90 hari |
  | Job pengiriman | 20 kunjungan/resep/penyerahan per koneksi per putaran |
  | Rekonsiliasi jarak jauh | 50 kunjungan per jam |

## 7. Persetujuan

| Peran | Nama | Keputusan | Tanggal | Catatan |
|---|---|---|---|---|
| Project Owner | Sumarto | ☑ Disetujui bersyarat | 17 Nov 2026 | DEC-045. Syarat: validasi sandbox SATUSEHAT (OD-058) sebelum pilot |
