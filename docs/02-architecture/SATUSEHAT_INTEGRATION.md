# SATUSEHAT Integration — Panduan Operasional (Stage 12)

> **Status: belum divalidasi di sandbox resmi SATUSEHAT.** Semua pengujian otomatis memakai simulator lokal (OD-121).
> Jangan menyatakan ClinicRME "terintegrasi" atau "compliant SATUSEHAT" sebelum validasi resmi berhasil dan buktinya tersimpan.
> Pemetaan resource: [FHIR_MAPPING.md](FHIR_MAPPING.md).

## 1. Gambaran

ClinicRME **mengirim** data rawat jalan ke SATUSEHAT. Tidak ada API FHIR publik untuk pihak ketiga (OD-009).
Pelayanan klinik tidak pernah diblokir oleh integrasi. Data yang belum lengkap ditahan dan ditampilkan sebagai pekerjaan yang perlu ditindaklanjuti.

| Komponen | Lokasi |
|---|---|
| Klien HTTP (OAuth2, klasifikasi error) + simulator | `libs/db/src/lib/satusehat.ts` |
| Kunjungan (Bundle Encounter + Condition + Observation + Procedure) | `libs/db/src/lib/satusehat-encounter.ts` |
| Tindak lanjut (resep, penyerahan obat, koreksi diagnosis, notifikasi dead-letter) | `libs/db/src/lib/satusehat-followup.ts` |
| Rekonsiliasi jarak jauh | `libs/db/src/lib/satusehat-reconcile.ts` |
| API admin | `libs/integration/src/lib/satusehat.controller.ts` |
| Halaman | Integrasi › SATUSEHAT (koneksi, master, Perlu tindakan) · Integrasi › Pemantauan SATUSEHAT (dashboard, rekonsiliasi) · panel di halaman kunjungan |

## 2. Lingkungan

| Lingkungan | Base URL | Dipakai untuk |
|---|---|---|
| `SIMULATOR` | — (di dalam proses) | lokal, test, E2E. **Ditolak di produksi** (`APP_ENV=prod`). Isi simulator hanya hidup di satu proses — rekonsiliasi jarak jauh terhadap simulator hanya bermakna di proses worker yang sama |
| `SANDBOX` | `SATUSEHAT_SANDBOX_URL` (bawaan `https://api-satusehat-stg.dto.kemkes.go.id`) | validasi sebelum pilot |
| `PRODUCTION` | `SATUSEHAT_PRODUCTION_URL` (bawaan `https://api-satusehat.kemkes.go.id`) | klinik yang sudah terdaftar |

Token: `POST /oauth2/v1/accesstoken?grant_type=client_credentials`. FHIR: `/fhir-r4/v1`. Token di-cache per koneksi; bila server menjawab 401, token diambil ulang lalu permintaan dicoba sekali lagi.

## 3. Menyiapkan klinik

1. **Kredensial (OD-058).** Klinik mendaftar di portal SATUSEHAT untuk mendapat *client ID*, *client secret*, dan *Organization ID*.
   - Admin klinik mengisinya sendiri di Integrasi › SATUSEHAT, per fasilitas.
   - Secret disimpan terenkripsi AES-256-GCM dan tidak pernah ditampilkan lagi.
   - Hanya satu koneksi aktif per fasilitas.
   - **Kredensial tidak boleh dikirim lewat chat atau email.**
2. **Uji koneksi.** Tombol ini mengambil token lalu membaca Organization. Hasilnya tersimpan sebagai status koneksi.
3. **Sinkron master (OD-117).**
   - Setiap poli/unit didaftarkan sebagai Location di bawah Organization. Prosesnya idempoten per identifier.
   - IHS tenaga kesehatan dicari dari NIK di Master tenaga kesehatan.
4. **IHS pasien (OD-116).** Job `integration.satusehat_ihs_lookup` berjalan tiap 10 menit. Admin juga dapat memakai tombol "Cari di SATUSEHAT" di halaman pasien.
   - Pasien tanpa NIK atau yang NIK-nya tidak ditemukan tetap dilayani, tetapi kunjungannya tertahan.
5. **Master obat.** Isi kode KFA. Obat tanpa KFA membuat resep tertahan dengan pesan "butuh kode KFA" (OD-118).

## 4. Alur pengiriman

| Job worker | Jadwal | Isi |
|---|---|---|
| `integration.satusehat_ihs_lookup` | tiap 10 menit | IHS pasien yang belum dicari |
| `integration.satusehat_send` | tiap 5 menit | Kunjungan yang RM-nya sudah disahkan dikirim sebagai satu Bundle (OD-115). Sesudahnya: resep terbit, penyerahan obat, addendum yang mengganti diagnosis (OD-120) |
| `integration.satusehat_reconcile` | tiap jam (menit 23) | Kunjungan terkirim dicocokkan dengan SATUSEHAT |
| `notify.outbox.dispatch` | tiap menit | Email dead-letter ke admin klinik |

Untuk operasional atau uji, job dapat dijalankan sekali lalu keluar: `WORKER_RUN_ONCE=integration.satusehat_send,integration.satusehat_reconcile node apps/worker/dist/main.js`.

### Status kiriman (`fhir_sync_record`)

| Status | Arti | Tindak lanjut |
|---|---|---|
| (tidak ada) | Antrean — disahkan, belum diproses | otomatis ≤ 5 menit |
| `BLOCKED` | Data belum lengkap. Pesan menyebut apa yang harus dilengkapi | Lengkapi datanya; dicek ulang tiap putaran |
| `PENDING` | Gangguan sementara (5xx, timeout, 429) | Dicoba ulang otomatis setelah ±1 m, 5 m, 30 m, 2 j |
| `DEAD` | Gagal setelah 5 percobaan | Email ke admin; **Kirim ulang** di Perlu tindakan |
| `ERROR` | Ditolak validasi SATUSEHAT (4xx), atau tidak ditemukan saat rekonsiliasi | Perbaiki data bila perlu, lalu **Kirim ulang** |
| `SENT` | Terkirim; ID SATUSEHAT tersimpan | — |
| `SKIPPED` | Pasien meminta pembatasan pemrosesan, atau addendum lama digantikan yang lebih baru | — |

Kredensial yang ditolak (401/403 setelah token baru) membuat klinik itu dilewati pada putaran tersebut tanpa mengubah status kiriman. Klinik lain tetap berjalan.

**Idempotensi.** Setiap percobaan ulang lebih dulu mencari resource per identifier lokal: Encounter per nomor kunjungan, MedicationRequest/Dispense per item resep. Resource yang ternyata sudah tersimpan tidak dikirim lagi. Bundle `transaction` bersifat atomik.

## 5. Pemantauan & rekonsiliasi (INT-FR-010, 011)

- **Dashboard** menampilkan:
  - total saat ini per status untuk kunjungan, resep, penyerahan obat, dan koreksi diagnosis;
  - antrean kunjungan disahkan yang belum diproses;
  - jumlah per hari (7–90 hari), dikelompokkan pada tanggal aktivitas terakhir dalam zona waktu cabang;
  - jumlah data ganda yang ditemukan di SATUSEHAT.
- **Rekonsiliasi** (rentang ≤ 92 hari, berdasarkan tanggal RM disahkan):
  - Selisih = disahkan − terkirim − dilewati (pembatasan pasien) + ID tidak cocok.
  - Setiap kunjungan yang perlu perhatian ditampilkan dengan alasannya. Daftar ini tidak memuat nama pasien.
- **Rekonsiliasi jarak jauh** (job tiap jam) berjalan untuk setiap kunjungan terkirim, sekali setelah setiap pengiriman atau pembaruan:
  - Encounter dicari per identifier. Bila tidak ada, kiriman menjadi `ERROR` dan muncul di Perlu tindakan.
  - ID Encounter yang berbeda diperbaiki.
  - Condition/Observation/Procedure dicari per Encounter. ID yang belum diketahui (karena respons hilang) diisi.
  - Resource ganda dihitung dan dilaporkan, **tidak dihapus otomatis**. Koreksi data ganda dilakukan manual setelah ditinjau.

## 6. Privasi & keamanan (OD-122)

- Dasar pengiriman adalah kewajiban fasyankes (Permenkes 24/2022), sehingga tidak ada opt-out per pasien. Pasien yang meminta pembatasan pemrosesan → `SKIPPED`.
  - *Konfirmasi PPDP/penasihat hukum diperlukan sebelum pilot (OD-069).*
- **Payload, token, dan secret tidak disimpan di log, audit, maupun outbox.** Yang disimpan hanya hash SHA-256 payload, status, ID SATUSEHAT, jumlah, dan pesan error operasional. Ini diuji di O04.
- Audit mencatat setiap pengiriman, penolakan, percobaan ulang, dead-letter, pembaruan diagnosis, rekonsiliasi yang tidak menemukan data, dan kirim ulang manual. Pelakunya SYSTEM, atau user untuk kirim ulang.
- Izin akses:

  | Izin | Mencakup |
  |---|---|
  | `integration.read` | lihat koneksi, Perlu tindakan, dashboard, rekonsiliasi |
  | `integration.manage` | simpan kredensial, uji koneksi, sinkron master, kirim ulang |
  | `clinical.record.read` | status SATUSEHAT per kunjungan |
  | `patient.update` | cari IHS pasien |

## 7. Pemecahan masalah

| Gejala | Penyebab umum | Langkah |
|---|---|---|
| Uji koneksi "kredensial ditolak" | client ID/secret salah atau lingkungan tertukar | Periksa lingkungan (sandbox ≠ produksi), simpan ulang secret |
| Kunjungan tertahan "belum punya nomor IHS" | NIK pasien kosong/salah | Perbaiki NIK, lalu klik "Cari di SATUSEHAT" |
| "Dokter … belum punya IHS" | NIK tenaga kesehatan kosong | Isi NIK di Master tenaga kesehatan, lalu Sinkron master |
| "… belum terdaftar sebagai Location" | poli baru | Sinkron master |
| "butuh kode KFA" | kode KFA obat kosong | Isi di Master obat |
| Banyak `PENDING`/`DEAD` | gangguan SATUSEHAT/jaringan | Tunggu, lalu Kirim ulang dari Perlu tindakan |
| Rekonsiliasi "tidak ditemukan di SATUSEHAT" | data dihapus/ditolak belakangan | Kirim ulang (Encounter baru dibuat setelah dicari per identifier) |
| "data ganda ditemukan di SATUSEHAT" | respons hilang saat koreksi diagnosis | Tinjau di SATUSEHAT; tandai entered-in-error manual |

## 8. Validasi sandbox (gate Stage 12 — menunggu OD-058)

Setelah kredensial sandbox tersedia:

1. Buat koneksi `SANDBOX`, lalu jalankan uji koneksi dan Sinkron master.
2. Pakai pasien dan tenaga kesehatan **uji resmi** dari dokumentasi SATUSEHAT, dan data ICD-10 resmi (UAT S7-1).
3. Jalankan satu kunjungan lengkap: tanda vital, diagnosis, tindakan, resep dengan KFA, dan penyerahan obat. Setelah itu tambahkan satu addendum yang mengganti diagnosis.
4. Simpan bukti: ID resource dari respons, dan tangkapan layar status di panel kunjungan, Perlu tindakan, dan rekonsiliasi (selisih 0). Simpan di `docs/reports/stage-12/sandbox-evidence/` **tanpa** data pasien nyata atau kredensial.
5. Cocokkan butir "Perlu dicek di sandbox" di FHIR_MAPPING.md, lalu perbarui mapping dan tanggal rujukannya.
