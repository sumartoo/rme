# Audit Policy — ClinicRME SaaS

| | |
|---|---|
| Versi | 0.1 — DRAFT (Stage 3) |
| Tanggal | 4 November 2026 |
| ADR | ADR-0007 |
| Requirement | AUD-FR-001..005, GEN-FR-002, NFR-AUD-001/002 |

## 1. Tujuan

Audit log menjawab: **siapa melakukan apa, terhadap data apa, kapan, dari mana** — sebagai bukti hukum, alat deteksi penyalahgunaan, dan dasar hak subjek data (AUD-FR-005).

## 2. Peristiwa yang Wajib Dicatat

| Kategori | Aksi (`audit_log.action`) | Contoh | `patient_id` |
|---|---|---|---|
| Autentikasi | `LOGIN`, `LOGIN_FAILED`, `LOGOUT`, `MFA_ENROLLED`, `MFA_FAILED`, `PASSWORD_RESET`, `SESSION_REVOKED` | Gagal login ke-5 → lockout | — |
| Akses data klinis | `READ` | Membuka layar encounter, detail pasien, riwayat, dokumen, hasil lab | ✓ |
| Perubahan data | `CREATE`, `UPDATE`, `DELETE` (hanya master non-klinis) | Ubah tarif, ubah data pasien | ✓ bila terkait |
| Klinis | `SIGN`, `ADDENDUM`, `PRESCRIBE`, `DISPENSE`, `SUBSTITUTION_APPROVED` | Pengesahan RM | ✓ |
| Keuangan | `INVOICE_ISSUED`, `PAYMENT`, `DISCOUNT_APPROVED`, `VOID_REQUESTED/APPROVED/REJECTED`, `REFUND_*`, `SHIFT_OPEN/CLOSE` | Refund disetujui | ✓ bila terkait |
| Stok | `STOCK_RECEIVED`, `ADJUSTMENT_*`, `OPNAME_APPROVED` | — | — |
| Administrasi | `USER_INVITED`, `USER_DISABLED`, `ROLE_CHANGED`, `PERMISSION_CHANGE`, `SETTINGS_CHANGED` | Role baru | — |
| Data massal | `EXPORT`, `IMPORT`, `TENANT_EXPORT` | Export laporan kunjungan | — |
| Platform | `TENANT_STATUS_CHANGED`, `SUPPORT_ACCESS_GRANTED`, `SUPPORT_ACCESS_USED` | Break-glass | — |
| Integrasi | `INTEGRATION_RETRY`, `INTEGRATION_CONFIG_CHANGED` | Kirim ulang manual | — |

## 3. Isi Entri

Lihat struktur `audit_log` di [DATA_DICTIONARY.md](../02-architecture/DATA_DICTIONARY.md#audit-log). Aturan isi:

- **Tidak memuat PHI mentah**: hanya ID resource, `patient_id`, dan nama field yang berubah. Nilai before/after hanya untuk master data non-PHI (tarif, role, pengaturan).
- `actor_kind`: `USER`, `SYSTEM` (worker/job), `PLATFORM_SUPPORT` (break-glass).
- `on_behalf_of` untuk delegasi (Lanjutan).
- `request_id` menghubungkan audit dengan log aplikasi.

## 4. Mekanisme

| Aspek | Ketentuan |
|---|---|
| Penulisan aksi tulis | `app.write_audit()` di dalam transaksi use case → audit dan data commit/rollback bersama |
| Penulisan akses baca | Dikumpulkan per request dan ditulis asinkron oleh worker (batch ≤ 5 detik); tetap masuk hash chain |
| Integritas | Append-only, hash chain per tenant (ADR-0007); trigger menolak UPDATE/DELETE |
| Verifikasi | Job harian `verify_audit_chain` per tenant; ketidakcocokan → insiden keamanan Sev-2 |
| Partisi | Bulanan; job membuat partisi bulan berikutnya |
| Waktu | `clock_timestamp()` server DB (UTC) |

## 5. Akses ke Audit

| Siapa | Akses |
|---|---|
| Tenant admin, Manajer, Auditor | Membaca audit tenant sendiri (`audit.log.read`) |
| Pasien (melalui klinik) | Daftar akses ke rekam medisnya (AUD-FR-005, Lanjutan) |
| Platform support | Hanya via break-glass, dan aksinya sendiri diaudit |
| Developer | Tidak memiliki akses ke audit produksi |

## 6. Retensi (OD-023 — diputuskan, DEC-019)

| Jenis | Masa simpan |
|---|---|
| Audit akses & perubahan rekam medis (`patient_id` terisi) | Sama dengan rekam medis: ≥ 25 tahun sejak kunjungan terakhir pasien |
| Audit keuangan & stok | 10 tahun (mengikuti masa simpan dokumen keuangan — DATA_RETENTION_POLICY §1) |
| Audit login & administrasi | 2 tahun |

Partisi lama dipindahkan ke penyimpanan dingin (ekspor terenkripsi ke GCS Archive) dengan hash akhir chain dicatat agar integritas tetap dapat diverifikasi.

## 7. Pemantauan Penyalahgunaan (Stage 9/14/15)

| Pola | Tindakan |
|---|---|
| User membuka > N rekam medis pasien berbeda per jam di luar pola normal | Notifikasi tenant admin |
| Akses RM pasien yang tidak memiliki kunjungan dengan user/cabang tersebut | Ditandai di laporan akses |
| Export di luar jam operasional / volume besar | Notifikasi |
| Akses break-glass | Selalu dinotifikasi ke tenant admin |
| Rantai hash rusak | Insiden keamanan |
