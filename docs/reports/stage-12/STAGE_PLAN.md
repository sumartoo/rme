# Stage 12 — Stage Plan

| | |
|---|---|
| Stage | 12 — FHIR & SATUSEHAT |
| Status | **BERJALAN** — OD diputuskan DEC-044 (16 Nov 2026) |
| Project Owner | Sumarto |
| Requirement | **MVP saja** (DEC-010): INT-FR-001–005, 008–012. Di luar stage ini (LJT): INT-FR-006 lab (ServiceRequest/Specimen/DiagnosticReport), INT-FR-007 Composition/resume |
| Mode verifikasi | Lokal penuh terhadap **simulator SATUSEHAT**, digabung tanpa CI sampai Actions aktif 1 Des 2026 (DEC-036). Validasi di **sandbox resmi** memerlukan kredensial dari PO (OD-058) |
| Batas klaim | Tidak ada klaim "terintegrasi/compliant SATUSEHAT" sampai ada bukti validasi resmi (gate Stage 12, aturan proyek) |

## 1. Tujuan

Data kunjungan rawat jalan terkirim otomatis ke SATUSEHAT dalam format HL7 FHIR R4:
- identitas pasien (IHS number) dicari dari NIK;
- kunjungan, diagnosis ICD-10, tanda vital, dan tindakan dikirim setelah rekam medis disahkan;
- resep dan penyerahan obat dikirim setelah terbit dan diserahkan.

Kegagalan tidak menghentikan pelayanan. Pengiriman di-retry otomatis, error tampil jelas di dashboard, dan kirim ulang manual tidak membuat data ganda.

## 2. Yang Sudah Ada

- **Skema baseline (Stage 3):**
  - `integration_connection` per fasilitas & lingkungan (SANDBOX/PRODUCTION), `fhir_sync_record` (unik per resource + data lokal), `integration_dead_letter`, `outbox_event`.
  - Kolom ID SATUSEHAT: `facility.satusehat_org_id`, `practitioner.satusehat_ihs_id`, `patient.ihs_number` + `ihs_status`, `encounter.satusehat_id`.
  - Kode: `service_item.icd9cm_code` (tindakan), `drug_item.kfa_code` (obat, DEC-032), diagnosis ICD-10 lewat `concept`.
- **Izin:** `integration.manage` dan `integration.read` sudah dipetakan ke operasi SATUSEHAT di OpenAPI.
- **Dari Stage 6–10:**
  - NIK pasien & tenaga kesehatan tersimpan terenkripsi (`libs/shared/crypto`).
  - Catatan klinis `SIGNED` (immutable) dan addendum.
  - Tanda vital terstruktur, diagnosis primer/sekunder, tindakan.
  - Resep terbit & penyerahan obat.
- **Pola yang dipakai ulang dari Stage 11:** adapter + simulator untuk layanan luar (seperti payment gateway QRIS), sehingga seluruh alur dapat diuji tanpa kredensial asli.

## 3. Batch

| Batch | Isi | Requirement |
|---|---|---|
| **1 — Koneksi & identitas** | Kredensial per fasilitas (terenkripsi), uji koneksi, token OAuth2 di-cache. **Simulator SATUSEHAT** lokal. Sinkron Organization (ID dari portal), Location per poli, Practitioner (cari IHS by NIK). Cari IHS pasien by NIK saat registrasi & lookup ulang | INT-FR-001, 002, 003 |
| **2 — Kunjungan rawat jalan** | Mapper FHIR: Encounter, Condition (ICD-10), Observation (tanda vital), Procedure (ICD-9-CM). Dikirim sebagai **Bundle** setelah RM disahkan (OD-115). Validasi payload sebelum kirim; error per item yang dapat ditindaklanjuti. Outbox → worker | INT-FR-004, 008 |
| **3 — Obat, retry & koreksi** | MedicationRequest (resep terbit) & MedicationDispense (diserahkan) dengan kode KFA. Retry + backoff, dead-letter + notifikasi admin, kirim ulang manual idempoten. Addendum yang mengubah diagnosis → update resource | INT-FR-005, 009, 012 |
| **4 — Dashboard, rekonsiliasi & gate** | Dashboard terkirim/tertunda/gagal per hari & daftar error. Rekonsiliasi kunjungan disahkan yang belum terkirim. Dokumen `FHIR_MAPPING.md` & `SATUSEHAT_INTEGRATION.md`. Uji gate; bukti sandbox bila kredensial tersedia. Completion report | INT-FR-010, 011, gate |

Perkiraan: ±1 hari kerja per batch.

## 4. Open Decision — ✅ semua disetujui sesuai usulan (DEC-044)

| OD | Pertanyaan | Usulan |
|---|---|---|
| **OD-058** | Akun sandbox SATUSEHAT | **Tindakan PO:** daftar di portal developer SATUSEHAT (satusehat.kemkes.go.id) untuk mendapat *client ID*, *client secret*, dan *Organization ID* sandbox. Jangan kirim kredensial lewat chat; isi langsung di halaman Integrasi setelah batch 1 selesai. Tanpa kredensial, pengembangan tetap berjalan dengan simulator (OD-121) |
| **OD-009** | Mengekspos FHIR API publik? | **Tidak di MVP.** ClinicRME hanya *mengirim* ke SATUSEHAT. API FHIR publik untuk pihak ketiga = LJT |
| **OD-042** | Resource wajib di MVP | Organization & Location, Practitioner (lookup), Patient (lookup IHS), **Encounter, Condition, Observation (tanda vital), Procedure, MedicationRequest, MedicationDispense**. LJT: lab (ServiceRequest/Specimen/DiagnosticReport, INT-FR-006), Composition (INT-FR-007), AllergyIntolerance, KYC SATUSEHAT Mobile. Daftar dicocokkan ulang dengan Playbook Rawat Jalan terbaru saat batch 2 dan tercatat di `FHIR_MAPPING.md` |
| **OD-114** | Penyimpanan kredensial | Disimpan **terenkripsi** di database (enkripsi aplikasi yang sama dengan NIK). `secret_ref` menunjuk entri terenkripsi itu. Pindah ke Secret Manager di Stage 15 (produksi). Rahasia tidak pernah tampil lagi setelah disimpan dan tidak masuk log/audit. *Catatan:* AC-INT-FR-001-1 menyebut "secret store" — di MVP sebelum Stage 15 dipenuhi dengan kolom terenkripsi; dicatat sebagai penyimpangan sementara |
| **OD-115** | Kapan & bagaimana kunjungan dikirim | **Satu Bundle per kunjungan** (Encounter + Condition + Observation + Procedure) dikirim **setelah catatan klinis disahkan**. Status Encounter dikirim `finished` beserta riwayat waktu datang–dilayani–selesai. Alasan: data sudah lengkap, satu transaksi, lebih sedikit update. Alternatif: kirim Encounter saat check-in lalu update saat selesai (lebih banyak panggilan & titik gagal) |
| **OD-116** | Pasien tanpa NIK / IHS tidak ditemukan | Pelayanan **tidak diblokir**. Resource kunjungan ditandai *ditunda — pasien belum punya IHS* di dashboard. Lookup otomatis diulang saat NIK diisi/diubah dan sekali sehari untuk yang tertunda (maks. 7 hari). Bayi baru lahir & WNA = LJT |
| **OD-117** | Pemetaan fasilitas, cabang, poli | **Fasilitas** = Organization SATUSEHAT (ID dari portal per fasyankes terdaftar). **Poli/unit** = Location di bawah Organization itu, dibuat lewat API saat sinkron master (ID disimpan di unit). Cabang yang terdaftar sebagai fasyankes terpisah dibuat sebagai fasilitas sendiri. **Tenaga kesehatan** dicari IHS-nya by NIK; yang tidak ditemukan tidak dapat menjadi praktisi pada data terkirim |
| **OD-118** | Kode untuk tindakan & obat | Tindakan memakai `icd9cm_code` di master layanan; layanan tanpa kode → Procedure tidak dikirim (ditandai di dashboard, kunjungan tetap terkirim). Obat memakai `kfa_code`; obat tanpa KFA → MedicationRequest/Dispense ditandai *butuh kode KFA*. Unduh katalog KFA otomatis = LJT; admin mengisi kode di master obat |
| **OD-119** | Retry & dead-letter | Error sementara (timeout, 5xx, 429) di-retry dengan backoff ±1 m, 5 m, 30 m, 2 j, 6 j. Setelah itu masuk dead-letter, dan admin klinik mendapat notifikasi in-app + email. Error validasi (4xx) **tidak** di-retry: langsung *perlu perbaikan data* dengan pesan dari SATUSEHAT. Token kedaluwarsa (401) → token baru + coba sekali lagi. Kirim ulang manual oleh pemegang `integration.manage`, teraudit, memakai identifier lokal sehingga tidak membuat resource ganda |
| **OD-120** | Koreksi setelah terkirim (addendum) | Addendum yang mengubah diagnosis mengirim **update Condition**. Diagnosis yang dihapus dikirim dengan status `entered-in-error`. Encounter tidak dihapus. Riwayat versi tersimpan di `fhir_sync_record` |
| **OD-121** | Pengujian tanpa sandbox | **Simulator SATUSEHAT** bawaan untuk lokal/test/E2E: endpoint OAuth2 & FHIR minimal, validasi struktur dasar, skenario error (401, 422, 500, timeout). Simulator ditolak di produksi. Butir gate "tervalidasi di sandbox" hanya dapat dicentang dengan kredensial OD-058; tanpa itu, Stage 12 diajukan **disetujui bersyarat** (validasi sandbox jadi syarat sebelum pilot) |
| **OD-122** | Dasar pengiriman data & privasi | Pengiriman data RME ke SATUSEHAT diperlakukan sebagai kewajiban fasyankes menurut ketentuan RME Kemenkes (Permenkes 24/2022). Karena itu tidak ada persetujuan atau opt-out per pasien di aplikasi. Kebijakan privasi klinik menyebut pengiriman ini. Payload & token **tidak** disimpan di log; yang disimpan hanya hash payload, status, dan pesan error. *Perlu konfirmasi PPDP/penasihat hukum sebelum pilot (OD-069)* |

## 5. Gate (dari STAGE_12_FHIR_SATUSEHAT.md, disesuaikan)

- [ ] Semua resource MVP tervalidasi di **sandbox SATUSEHAT**, bukti tersimpan (bergantung OD-058)
- [ ] Semua resource MVP lolos uji kontrak terhadap simulator (struktur, referensi, terminologi)
- [ ] Uji idempotensi: event ganda & kirim ulang tidak membuat resource ganda
- [ ] Uji kegagalan jaringan, error validasi, dan token kedaluwarsa
- [ ] Rekonsiliasi menunjukkan 0 selisih pada dataset uji
- [ ] Payload & kredensial tidak muncul di log/audit; kredensial terenkripsi
- [ ] Tidak ada klaim "SATUSEHAT compliant/terintegrasi resmi" tanpa bukti validasi resmi
- [ ] Matriks permission X01 mencakup semua endpoint baru; uji mutasi kontrol baru terdeteksi
- [ ] PO menyetujui Stage 12

## 6. Risiko & catatan

- **Data ICD-10 resmi (S7-1).** Katalog ICD-10 saat ini masih data sintetis/terbatas. Validasi Condition di sandbox membutuhkan kode ICD-10 yang valid, sehingga S7-1 sebaiknya diselesaikan sebelum uji sandbox.
- **Ketentuan SATUSEHAT berubah dari waktu ke waktu** (playbook, profil, kewajiban modul). Mapping dicocokkan dengan dokumentasi resmi saat batch 2–3 dan tanggal rujukannya dicatat.
- **Kredensial produksi** per fasyankes diperoleh klinik pilot sendiri lewat registrasi SATUSEHAT (Stage 16).

## 7. Progres

| Tanggal | Catatan | Bukti |
|---|---|---|
| 16 Nov 2026 | Stage 11 disetujui (DEC-043). Draf rencana & OD Stage 12 disusun | — |
| 16 Nov 2026 | PO menyetujui semua OD Stage 12 (DEC-044). Batch 1 dimulai | — |
| 16 Nov 2026 | **Batch 1 selesai** — koneksi & identitas: migrasi 0031 (lingkungan SIMULATOR, kredensial terenkripsi per fasilitas & satu koneksi aktif, status kirim per koneksi, jejak lookup IHS, menu Integrasi › SATUSEHAT). Klien SATUSEHAT HTTP (token OAuth2 di-cache, 401 → token baru, klasifikasi error AUTH/VALIDATION/NOT_FOUND/TRANSIENT, timeout) + **simulator** deterministik (OD-121). Halaman admin: simpan kredensial (tidak pernah ditampilkan lagi), uji koneksi, sinkron master — Location per poli dibuat idempoten, IHS nakes dari NIK (OD-117). Lookup IHS pasien manual di halaman pasien + job worker tiap 10 menit (PENDING segera, gagal sehari sekali, ≤ 7 hari, pasien dibatasi dilewati) (OD-116). Ganti lingkungan mereset IHS untuk dicari ulang | Integrasi J01–J06, unit klien HTTP/simulator, E2E W35, mutasi M134–M141 |
| 17 Nov 2026 | **Batch 2 selesai** — kunjungan rawat jalan: migrasi 0032 (status BLOCKED/SKIPPED, jadwal coba ulang, daftar masalah, relasi induk). Mapper FHIR Encounter + Condition (ICD-10) + Observation (tanda vital, LOINC/UCUM) + Procedure (ICD-9-CM) dalam satu Bundle transaction setelah RM disahkan (OD-115). Validasi sebelum kirim dengan pesan yang dapat ditindaklanjuti; tertahan dicek ulang tiap putaran (INT-FR-008). Job worker tiap 5 menit; gangguan dicoba ulang dengan backoff lalu DEAD, ditolak → ERROR (OD-119); respons hilang → cari Encounter per identifier, tanpa duplikat. Status SATUSEHAT di halaman kunjungan; mode `WORKER_RUN_ONCE` untuk menjalankan job sekali. `FHIR_MAPPING.md` (draf, belum divalidasi sandbox) | Integrasi U01–U06, unit mapper, E2E W36, mutasi M142–M151 |
