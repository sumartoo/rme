# Stage 13 — Android Patient Application

| | |
|---|---|
| Phase | E — Integrasi & Kanal |
| Status | Belum dimulai |
| Prasyarat | Stage 12 disetujui |
| Modul | `portal`, `notification`, aplikasi `android/` |

## 1. Tujuan

Memberi pasien akses aman terhadap informasi kesehatannya sendiri.

## 2. Ruang Lingkup

- Aplikasi Kotlin + Jetpack Compose.
- Login & verifikasi identitas (tautkan akun ke rekam pasien).
- Pemulihan akun & manajemen perangkat.
- Riwayat kunjungan & diagnosis.
- Riwayat resep & obat.
- Hasil laboratorium.
- Unduh dokumen medis.
- Jadwal kontrol & pengingat; (opsional) booking appointment.
- Akun wali untuk anak/pasien yang memerlukan pendamping.
- Notifikasi tanpa informasi medis sensitif.
- Pencabutan sesi perangkat hilang.

## 3. Rancangan

### 3.1 Identitas Pasien vs Tenant

Satu akun pasien dapat terhubung ke beberapa tenant (klinik berbeda). Penautan per tenant memerlukan verifikasi (mis. OTP ke nomor terdaftar di klinik + data identitas, atau kode dari petugas).

| Tabel | Keterangan |
|---|---|
| `portal_account` | global: phone/email, status, mfa |
| `portal_link` | portal_account_id, tenant_id, patient_id, relation (SELF/GUARDIAN), verified_at, revoked_at |
| `portal_device` | account_id, device_id, push_token, last_seen, revoked_at |

API `/api/patient/v1` hanya mengembalikan data `patient_id` yang tertaut dan data yang sudah **disahkan**.

### 3.2 Arsitektur Aplikasi

```
ui (Compose screens) → viewmodel → domain (use case) → data (repository)
  → remote (Retrofit/Ktor + OpenAPI client) | local (Room terenkripsi, cache minimal)
```

Keamanan mobile: token di Android Keystore, certificate pinning (OD-043), blokir screenshot di layar sensitif, tidak ada log PHI, deteksi root (peringatan).

### 3.3 Notifikasi

Isi generik: "Ada informasi baru dari Klinik X. Buka aplikasi untuk melihat." — bukan nama obat, diagnosis, atau hasil.

## 4. Requirement Awal

| ID | Ringkasan |
|---|---|
| POR-FR-001 | Registrasi & penautan akun ke pasien di klinik |
| POR-FR-002 | Melihat riwayat kunjungan & diagnosis |
| POR-FR-003 | Melihat resep & hasil lab |
| POR-FR-004 | Unduh dokumen medis |
| POR-FR-005 | Akun wali dengan persetujuan |
| POR-FR-006 | Cabut sesi perangkat |
| POR-FR-007 | Notifikasi tanpa data sensitif |

## 5. Deliverable

Aplikasi Android, modul `portal`, OpenAPI patient API, `MOBILE_SECURITY.md`, test (unit, UI, API), completion report.

## 6. Gate Checklist

- [ ] Uji akses: pasien hanya melihat data tertaut miliknya.
- [ ] Uji keamanan mobile (mengacu OWASP MASVS).
- [ ] Uji pencabutan perangkat efektif segera.
- [ ] Uji sinkronisasi & mode offline baca-saja.
- [ ] Konten notifikasi diverifikasi bebas PHI.
- [ ] Project Owner menyetujui Stage 13.

## 7. Open Decision

- **OD-014 / OD-017** — Library & minSdk Android.
- **OD-043** — Certificate pinning.
- **OD-044** — Batas usia/aturan akun wali.
- **OD-045** — Apakah dokumen medis yang diunduh perlu watermark.
