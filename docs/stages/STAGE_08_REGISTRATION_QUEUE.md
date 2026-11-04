# Stage 8 — Patient Registration, Scheduling & Queue

| | |
|---|---|
| Phase | D — Operasional Klinik |
| Status | Belum dimulai |
| Prasyarat | Stage 7 disetujui |
| Modul | `patient`, `scheduling`, `notification` |

## 1. Tujuan

Mengelola identitas pasien dan alur kedatangan dari pendaftaran hingga masuk ruang periksa.

## 2. Ruang Lingkup

- Registrasi pasien baru & pencarian pasien lama.
- Pencegahan duplikasi identitas.
- Identitas, alamat, kontak darurat, wali.
- Kategori pasien & penjamin (umum, asuransi, perusahaan).
- Pendaftaran online & walk-in.
- Jadwal praktik dokter & appointment.
- Antrean & nomor kunjungan.
- Pembatalan & jadwal ulang.
- Pasien terlambat & no-show.
- Riwayat kunjungan.
- Verifikasi identitas & hak akses pasien.

## 3. Rancangan

### 3.1 Master Patient Index

| Tabel | Kolom penting |
|---|---|
| `patient` | tenant_id, mrn, full_name, birth_date, sex, nik_hash, nik_encrypted, phone, address, status, merged_into |
| `patient_identifier` | patient_id, system (NIK/PASPOR/IHS/BPJS), value_encrypted, value_hash |
| `patient_contact` | patient_id, relation, name, phone, is_guardian |
| `patient_coverage` | patient_id, payer_id, member_no, valid_from, valid_to, plan |
| `patient_consent` | patient_id, consent_type, version, granted_at, revoked_at |

**Deteksi duplikat:** match NIK hash (pasti) → kandidat berdasarkan nama (trigram) + tanggal lahir + jenis kelamin (skor) → petugas memutuskan. Penggabungan (merge) memerlukan permission khusus & teraudit, tidak menghapus data.

### 3.2 Jadwal & Antrean

| Tabel | Kolom |
|---|---|
| `practitioner_schedule` | practitioner_id, branch_id, unit_id, day_of_week, start, end, quota |
| `schedule_exception` | cuti/libur |
| `appointment` | patient_id, slot, status (BOOKED/CHECKED_IN/CANCELLED/NO_SHOW/RESCHEDULED), channel |
| `encounter` | dibuat saat check-in; status awal ARRIVED |
| `queue_ticket` | branch_id, unit_id, date, number, encounter_id, status, called_at |

Nomor antrean dibuat atomik per cabang/unit/hari. Pemanggilan antrean dipublikasikan via SSE/WebSocket ke layar TV.

### 3.3 Aturan Keterlambatan & No-show

Konfigurasi per tenant: batas toleransi terlambat, auto no-show setelah X menit, kebijakan prioritas ulang.

## 4. Requirement Awal

| ID | Ringkasan |
|---|---|
| REG-FR-001 | Registrasi pasien baru dengan MRN otomatis |
| REG-FR-002 | Pencarian pasien by nama/NIK/MRN/telepon/tanggal lahir |
| REG-FR-003 | Peringatan kandidat duplikat sebelum simpan |
| REG-FR-004 | Merge pasien dengan audit |
| SCH-FR-001 | Appointment berdasarkan slot & kuota dokter |
| SCH-FR-002 | Walk-in langsung mendapat nomor antrean |
| SCH-FR-003 | Panggil/lewati/panggil ulang antrean; tampilan TV |
| SCH-FR-004 | Pembatalan & reschedule dengan alasan |
| SCH-FR-005 | Auto no-show sesuai konfigurasi |

## 5. Deliverable

Modul `patient` & `scheduling`, layar pendaftaran/appointment/antrean/TV, test, completion report.

## 6. Gate Checklist

- [ ] Alur WF-01 s.d. WF-04 tahap pendaftaran teruji untuk setiap kategori pasien.
- [ ] Uji konkurensi nomor antrean (tanpa duplikat).
- [ ] Uji deteksi duplikat dengan dataset sintetis.
- [ ] NIK tersimpan terenkripsi; pencarian via hash.
- [ ] Project Owner menyetujui Stage 8.

## 7. Open Decision

- **OD-012** — Provider notifikasi pengingat appointment.
- **OD-032** — Verifikasi eligibilitas asuransi: manual atau integrasi.
