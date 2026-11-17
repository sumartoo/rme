# FHIR Mapping — SATUSEHAT (Stage 12)

> **Status: draf teknis, belum divalidasi di sandbox resmi SATUSEHAT.** Dokumen ini **bukan** klaim kepatuhan
> atau "terintegrasi SATUSEHAT". Semua pengujian otomatis memakai **simulator** lokal (OD-121). Pemetaan wajib
> dicocokkan ulang per elemen dengan dokumentasi resmi dan diuji di sandbox sebelum gate Stage 12 / pilot.

| Rujukan | Dicek |
|---|---|
| Dokumentasi resmi — Modul Interoperabilitas › Rawat Jalan: <https://dokumentasisatusehat-stg.dto.kemkes.go.id/modul-interoperabilitas/rawat-jalan> | 17 Nov 2026 (ringkas, belum per elemen) |
| Koleksi Postman resmi "01. Pelayanan - Rawat Jalan" (Playbook Modul Rawat Jalan v5.x): <https://link.kemkes.go.id/PostmanModulPelayananRawatJalan> | 17 Nov 2026 (ringkas) |

Ketentuan SATUSEHAT berubah dari waktu ke waktu. Setiap pembaruan mapping mencatat tanggal rujukannya di tabel ini.

## 1. Alur pengiriman (OD-115, OD-118, OD-119 / DEC-044)

1. Dokter mengesahkan catatan klinis → kunjungan menjadi sasaran job worker `integration.satusehat_send` (tiap 5 menit).
2. **Validasi sebelum kirim** (INT-FR-008, `validateEncounter`). Bila ada masalah yang memblokir → `BLOCKED` + daftar masalah
   yang dapat ditindaklanjuti (tanpa isi rekam medis), dicek ulang tiap putaran sampai dilengkapi.
3. Satu **Bundle `transaction`** per kunjungan: `POST {fhir-base}` berisi Encounter + Condition + Observation + Procedure.
   Rujukan antar-entry memakai `urn:uuid:<id lokal>`.
4. Hasil per sumber daya disimpan di `fhir_sync_record` (status, ID SATUSEHAT, `payload_hash` SHA-256, `parent_id` ke Encounter).
   **Payload tidak disimpan.** `encounter.satusehat_id` diisi. Audit SYSTEM hanya berisi jumlah & status.

| Kondisi | Status | Tindak lanjut |
|---|---|---|
| Pasien meminta pembatasan pemrosesan | `SKIPPED` | Tidak dikirim |
| Data belum lengkap | `BLOCKED` | Dicek ulang tiap putaran |
| Ditolak validasi SATUSEHAT (4xx) | `ERROR` | Tidak dicoba ulang; pesan OperationOutcome ditampilkan. Kirim ulang manual: batch 3 |
| Gangguan sementara (5xx/timeout/429) | `PENDING` | Backoff ±1 m, 5 m, 30 m, 2 j, 6 j → `DEAD` setelah 5 percobaan (notifikasi & kirim ulang: batch 3) |
| Kredensial ditolak (401/403) | — | Klinik itu dilewati putaran ini; klinik lain tetap jalan |

**Idempotensi.** Encounter memakai `identifier` `http://sys-ids.kemkes.go.id/encounter/{organizationId}` = nomor kunjungan.
Setelah percobaan gagal sementara, worker lebih dulu mencari `GET /Encounter?identifier=…`. Karena Bundle `transaction`
bersifat atomik, bila Encounter sudah ada maka seluruh isinya dianggap tersimpan dan **tidak dikirim ulang** (mencegah
duplikat); ID sumber daya turunan diisi saat rekonsiliasi (batch 4).

## 2. Validasi yang memblokir (INT-FR-008)

| Aturan | Pesan |
|---|---|
| Pasien punya IHS (`ihs_status = FOUND`) | sesuai penyebab: tanpa NIK / NIK tidak ditemukan / belum dicari |
| Dokter penanggung jawab punya IHS | lengkapi NIK lalu Sinkron master |
| Poli/unit terdaftar sebagai Location (koneksi aktif) | jalankan Sinkron master |
| Waktu kedatangan terisi | — |
| Ada diagnosis primer | — |
| Semua kode diagnosis ICD-10 (`^[A-Z]\d{2}(\.\d{1,2})?$`) | — |

Peringatan (tidak memblokir; bagian itu tidak dikirim): tanda vital tanpa padanan LOINC (`PAIN_SCALE`, `OTHER`) atau tanpa
nilai angka; tindakan tanpa kode ICD-9-CM.

## 3. Encounter

| Elemen FHIR | Sumber ClinicRME |
|---|---|
| `identifier[0]` | system `http://sys-ids.kemkes.go.id/encounter/{organizationId}`, value `encounter.encounter_no` |
| `status` | `finished` (dikirim setelah RM disahkan) |
| `class` | `v3-ActCode` `AMB` |
| `subject` | `Patient/{patient.ihs_number}` |
| `participant[0]` | type `v3-ParticipationType` `ATND`; individual `Practitioner/{practitioner.satusehat_ihs_id}` |
| `period` | start `arrived_at`; end `consult_ended_at` → `finished_at` → `clinical_note.signed_at` |
| `statusHistory` | arrived (`arrived_at`→`consult_started_at`), in-progress (→ end), finished |
| `location[0]` | `Location/{id}` dari `fhir_sync_record` (Location/service_unit, koneksi aktif) |
| `diagnosis[]` | rujukan Condition, `diagnosis-role` `DD`, `rank` 1 = primer |
| `serviceProvider` | `Organization/{organizationId}` |

## 4. Condition (diagnosis)

`clinicalStatus` active · `category` `encounter-diagnosis` · `code` `http://hl7.org/fhir/sid/icd-10` (`concept.code`, display
`display_en` → `display_id`) · `subject` · `encounter`.

## 5. Observation (tanda vital — nilai terakhir per jenis)

`status` final · `category` `vital-signs` · `subject` · `performer` dokter · `encounter` · `effectiveDateTime`/`issued` =
`recorded_at` · `valueQuantity` UCUM.

| Kode ClinicRME | LOINC | UCUM |
|---|---|---|
| SYSTOLIC | 8480-6 | mm[Hg] |
| DIASTOLIC | 8462-4 | mm[Hg] |
| HEART_RATE | 8867-4 | /min |
| RESP_RATE | 9279-1 | /min |
| TEMPERATURE | 8310-5 | Cel |
| SPO2 | 59408-5 | % |
| WEIGHT | 29463-7 | kg |
| HEIGHT | 8302-2 | cm |
| BMI | 39156-5 | kg/m2 |
| PAIN_SCALE, OTHER | — (belum dipetakan) | — |

## 6. Procedure (tindakan)

`status` completed · `code` `http://hl7.org/fhir/sid/icd-9-cm` (`service_item.icd9cm_code`) · `subject` · `encounter` ·
`performedPeriod` = `performed_at` · `performer` dokter.

## 7. Perlu dicek di sandbox sebelum gate

- Elemen wajib terbaru di playbook (mis. `Encounter.class` & `statusHistory` per tahap, kategori Observation, kode display).
- Apakah Observation tanda vital wajib dikirim per pengukuran atau cukup nilai terakhir.
- Data ICD-10 resmi (UAT S7-1) — data uji saat ini sintetis.
- Batch 3: MedicationRequest/MedicationDispense (KFA), pembaruan setelah addendum, kirim ulang manual.
