# Stage 9 — Clinical Workflow & Rekam Medis

| | |
|---|---|
| Phase | D — Operasional Klinik |
| Status | **Perencanaan** — Stage 8 disetujui (DEC-037); rencana di `docs/reports/stage-9/STAGE_PLAN.md` |
| Prasyarat | Stage 8 disetujui |
| Modul | `clinical`, `document`, `integration` (lab order) |

## 1. Tujuan

Menyediakan dokumentasi klinis rawat jalan yang lengkap, aman, dan berintegritas — termasuk pengesahan dan koreksi yang sah.

## 2. Ruang Lingkup

- Anamnesis & SOAP.
- Tanda vital & pemeriksaan fisik.
- Riwayat penyakit, alergi, obat yang sedang digunakan.
- Diagnosis ICD-10 (primer/sekunder) & tindakan ICD-9-CM.
- Template klinis per spesialisasi.
- Resep elektronik (racikan & non-racikan).
- Order lab ke aplikasi lab eksisting & tampilan hasil.
- Resume medis & surat keterangan (sehat, sakit, rujukan).
- Rujukan & rencana tindak lanjut.
- Penandatanganan & pengesahan rekam medis.
- Addendum untuk koreksi.
- Clinical safety review.

## 3. Rancangan

### 3.1 Layar Encounter (Dokter)

```
┌─ Header pasien: nama, MRN, umur, jenis kelamin, penjamin, ⚠ alergi ─┐
│ Tab: Ringkasan | SOAP | Vital | Diagnosis & Tindakan | Resep | Lab | Dokumen | Riwayat │
│ Panel kanan: kunjungan sebelumnya, obat aktif, hasil lab terakhir          │
└─ Aksi: Simpan Draft | Sahkan | Rujuk | Selesai ─────────────────────────┘
```

### 3.2 Tabel Inti

| Tabel | Keterangan |
|---|---|
| `encounter` | status, practitioner_id, unit_id, started_at, ended_at |
| `clinical_note` | encounter_id, template_code, subjective, objective, assessment, plan, status (DRAFT/SIGNED), signed_by, signed_at, content_hash |
| `clinical_addendum` | note_id, reason, content, author, signed_at |
| `observation` | encounter_id, code (vital), value, unit, recorded_by, recorded_at |
| `allergy_intolerance` | patient_id, substance, reaction, severity, status |
| `condition_dx` | encounter_id, concept_id (ICD-10), rank (primer/sekunder), clinical_status |
| `procedure_act` | encounter_id, concept_id (ICD-9-CM), performed_by |
| `prescription` / `prescription_item` | drug_id/racikan, dosis, frekuensi, rute, durasi, jumlah, instruksi |
| `lab_order` / `lab_result` | external_order_no, status, result payload, received_at |
| `medical_document` | type (resume/surat), template, generated_pdf_object, signed |
| `referral` | tujuan, alasan, dokumen |

### 3.3 Aturan Integritas

1. Catatan berstatus `SIGNED` tidak dapat diubah (trigger DB + validasi aplikasi).
2. Koreksi hanya melalui `clinical_addendum` yang juga ditandatangani.
3. `content_hash` dihitung saat pengesahan untuk deteksi perubahan.
4. Setiap pembacaan rekam medis tercatat di audit log.
5. Hanya dokter penanggung jawab (atau yang diberi delegasi) yang dapat mengesahkan.

### 3.4 Clinical Safety (MVP)

- Peringatan alergi saat meresepkan.
- Peringatan duplikasi obat dalam satu resep.
- Validasi dosis: format & batas wajar (bukan clinical decision support penuh — OD-033).

## 4. Requirement Awal

| ID | Ringkasan |
|---|---|
| CLN-FR-001 | Dokter mengisi SOAP dengan template |
| CLN-FR-002 | Perawat merekam tanda vital |
| CLN-FR-003 | Diagnosis ICD-10 primer wajib sebelum pengesahan |
| CLN-FR-004 | Resep elektronik terkirim ke worklist farmasi |
| CLN-FR-005 | Pengesahan mengunci catatan |
| CLN-FR-006 | Addendum dengan alasan & tanda tangan |
| CLN-FR-007 | Order lab terkirim ke aplikasi lab & hasil tampil |
| CLN-FR-008 | Generate resume medis & surat keterangan PDF |
| CLN-FR-009 | Peringatan alergi saat resep |

## 5. Deliverable

Modul `clinical` & `document`, adapter lab (minimal satu vendor), layar encounter, template dokumen, `CLINICAL_SAFETY_REVIEW.md`, test, completion report.

## 6. Gate Checklist

- [ ] Workflow klinis divalidasi clinical advisor.
- [ ] Test: catatan SIGNED tidak dapat diubah via API maupun SQL role aplikasi.
- [ ] Test addendum & hash integritas.
- [ ] Audit akses baca rekam medis berfungsi.
- [ ] Order & hasil lab teruji dengan sandbox/mock vendor.
- [ ] Project Owner menyetujui Stage 9.

## 7. Open Decision

- **OD-033** — Cakupan clinical decision support (interaksi obat, dosis berdasarkan berat badan).
- **OD-034** — Mekanisme tanda tangan: tanda tangan elektronik internal vs tersertifikasi (PSrE).
- **OD-035** — Daftar template spesialisasi untuk MVP.
