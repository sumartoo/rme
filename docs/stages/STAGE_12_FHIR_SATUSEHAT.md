# Stage 12 — FHIR & SATUSEHAT

| | |
|---|---|
| Phase | E — Integrasi & Kanal |
| Status | Belum dimulai |
| Prasyarat | Stage 11 disetujui |
| Modul | `integration`, `terminology` |

## 1. Tujuan

Menyediakan interoperabilitas HL7 FHIR R4 dan integrasi resmi dengan platform SATUSEHAT.

## 2. Ruang Lingkup

- Mapping data internal → resource FHIR.
- Terminologi & kode referensi (ICD-10, LOINC/SNOMED bila diwajibkan, KFA).
- Sinkronisasi identitas pasien (IHS number), fasilitas (Organization/Location), tenaga kesehatan (Practitioner).
- Pengiriman data klinis sesuai kewajiban.
- Adapter SATUSEHAT & manajemen kredensial per fasilitas.
- Validasi payload sebelum kirim.
- Sandbox testing.
- Retry, idempotency, dead-letter handling.
- Monitoring status integrasi.
- Rekonsiliasi data lokal vs terkirim.

## 3. Rancangan

### 3.1 Mapping Awal (untuk dikonfirmasi terhadap panduan SATUSEHAT terbaru)

| Data internal | Resource FHIR | Pemicu |
|---|---|---|
| Fasilitas/cabang | Organization, Location | Setup tenant |
| Tenaga kesehatan | Practitioner (lookup by NIK) | Setup master |
| Pasien | Patient (lookup IHS by NIK) | Registrasi |
| Encounter | Encounter | Check-in & selesai |
| Diagnosis | Condition | Pengesahan RM |
| Tanda vital | Observation | Pengesahan RM |
| Tindakan | Procedure | Pengesahan RM |
| Resep | MedicationRequest (+ Medication) | Resep issued |
| Dispensing | MedicationDispense | Dispensed |
| Order lab / hasil | ServiceRequest, Specimen, DiagnosticReport, Observation | Order & hasil |
| Ringkasan | Composition | Sesuai kewajiban |
| Alergi | AllergyIntolerance | Pencatatan |

### 3.2 Arsitektur

```
Domain event (EncounterSigned, PrescriptionIssued, ...)
  → outbox_event
  → Worker: FhirMapper → Validator (profil SATUSEHAT) → SatuSehatClient
  → simpan fhir_sync_record (local_id, resource_type, satusehat_id, version, status, last_error)
  → gagal permanen → integration_dead_letter + notifikasi admin
```

- Token OAuth2 per fasilitas di-cache & di-refresh; kredensial di Secret Manager.
- Urutan dependensi dijaga (Patient & Encounter harus terkirim sebelum Condition).
- Koreksi (addendum) dikirim sebagai update resource sesuai aturan SATUSEHAT.

### 3.3 Dashboard Integrasi

Per tenant: jumlah terkirim/gagal/tertunda, error terbanyak, tombol kirim ulang (dengan audit), laporan rekonsiliasi.

## 4. Requirement Awal

| ID | Ringkasan |
|---|---|
| INT-FR-001 | Lookup IHS pasien by NIK |
| INT-FR-002 | Pengiriman Encounter & Condition otomatis setelah pengesahan |
| INT-FR-003 | Validasi payload sebelum kirim |
| INT-FR-004 | Retry & dead-letter dengan kirim ulang manual |
| INT-FR-005 | Rekonsiliasi lokal vs SATUSEHAT |

## 5. Deliverable

`FHIR_MAPPING.md`, `SATUSEHAT_INTEGRATION.md`, adapter & mapper, test kontrak, bukti uji sandbox, completion report.

## 6. Gate Checklist

- [ ] Semua resource wajib tervalidasi di sandbox SATUSEHAT (bukti tersimpan).
- [ ] Uji idempotency: event ganda tidak membuat resource ganda.
- [ ] Uji kegagalan jaringan & token kedaluwarsa.
- [ ] Rekonsiliasi menunjukkan 0 selisih pada dataset uji.
- [ ] Tidak ada klaim "SATUSEHAT compliant" tanpa bukti validasi resmi.
- [ ] Project Owner menyetujui Stage 12.

## 7. Open Decision

- **OD-009** — Mengekspos FHIR API publik?
- **OD-042** — Daftar resource wajib final berdasarkan ketentuan terbaru saat stage dimulai.
