# Stage 3 — Security, Privacy & Compliance Foundation

| | |
|---|---|
| Phase | B — Fondasi Teknis |
| Status | **Disetujui** 4 Nov 2026 (DEC-020) |
| Prasyarat | Stage 2 disetujui |
| Stage berikutnya | Stage 4 — DevOps Foundation |

> **Catatan urutan (OD-018):** Implementasi kontrol keamanan (auth, RLS, audit log) membutuhkan repository dan pipeline yang biasanya dibuat di Stage 4. Usulan: Stage 3 menghasilkan **desain kontrol + proof-of-concept** di repository sementara, lalu implementasi final dipasang di Stage 4. Alternatif: tukar urutan Stage 3 dan 4. **Diputuskan: Stage 3 = desain + PoC (DEC-008).**

## 1. Tujuan

Membangun kontrol keamanan dan privasi inti **sebelum** data klinis disimpan.

## 2. Ruang Lingkup

- Threat modeling (STRIDE) & security risk assessment.
- Autentikasi sesuai ADR-0003: Google Sign-In (OIDC + PKCE), email/password (Argon2id, lockout, reset), undangan user, sesi cookie, MFA TOTP untuk akun administratif.
- RBAC + permission-based authorization.
- PostgreSQL RLS & isolasi tenant di semua lapisan.
- Enkripsi in transit & at rest; enkripsi kolom data identitas sensitif.
- Secret management.
- Audit log tahan manipulasi.
- Consent pasien & hak subjek data (akses, koreksi, pembatasan).
- Kebijakan retensi & pemusnahan data.
- HIPAA Security Rule gap assessment.
- Prosedur respons insiden & pemberitahuan kebocoran data.

## 3. Rancangan Pekerjaan

### 3.1 Threat Model — Aset & Ancaman Prioritas

| Aset | Ancaman utama | Kontrol |
|---|---|---|
| Rekam medis | Akses lintas tenant, insider, ubah data setelah disahkan | RLS, permission, immutability trigger, audit baca |
| Kredensial | Credential stuffing, phishing | Rate limit, lockout, MFA, deteksi anomali |
| Token | Pencurian/replay | Token pendek, refresh rotasi, revoke per device |
| Pembayaran | Callback palsu, double-posting | Verifikasi signature, idempotency, rekonsiliasi |
| Export laporan | Exfiltrasi data massal | Permission export, watermark, batas baris, audit |
| Superadmin | Penyalahgunaan akses | Tanpa akses data klinis by default, break-glass teraudit |

### 3.2 Audit Log

| Kolom | Keterangan |
|---|---|
| `id`, `tenant_id`, `occurred_at` | |
| `actor_user_id`, `actor_role`, `on_behalf_of` | Termasuk delegasi/break-glass |
| `action` | `CREATE`, `READ`, `UPDATE`, `SIGN`, `ADDENDUM`, `EXPORT`, `LOGIN`, ... |
| `resource_type`, `resource_id` | |
| `ip`, `user_agent`, `request_id` | |
| `change_summary` | Diff field (tanpa nilai PHI mentah bila tidak perlu) |
| `prev_hash`, `hash` | SHA-256 berantai per tenant |

Tabel hanya `INSERT`; role aplikasi tidak memiliki hak `UPDATE/DELETE`. Verifikasi chain dijalankan terjadwal.

### 3.3 Model Permission

```
<modul>.<resource>.<aksi>
clinical.note.read | clinical.note.write | clinical.note.sign | clinical.note.addendum
billing.payment.create | billing.refund.approve
report.export | iam.role.manage | platform.tenant.manage
```

Evaluasi akses = permission ∧ cabang yang ditugaskan ∧ status akun aktif ∧ (opsional) jadwal jaga.

## 4. Deliverable

| File | Lokasi |
|---|---|
| THREAT_MODEL.md | docs/03-security/ |
| SECURITY_CONTROLS.md | docs/03-security/ |
| HIPAA_GAP_ASSESSMENT.md | docs/03-security/ |
| PRIVACY_AND_PDP.md | docs/03-security/ |
| AUDIT_POLICY.md | docs/03-security/ |
| DATA_RETENTION_POLICY.md | docs/03-security/ |
| INCIDENT_RESPONSE_PLAN.md | docs/03-security/ |
| Kode: auth, tenant context, RLS migration, audit module | backend/ |
| Test: tenant isolation suite, authz test, audit chain test | backend/src/test |
| STAGE_COMPLETION_REPORT.md | docs/reports/stage-3/ |

## 5. Gate Checklist

- [ ] Threat model direview & risiko tinggi memiliki kontrol.
- [ ] Test isolasi tenant: tenant A tidak dapat membaca/menulis data tenant B melalui API maupun query langsung dengan role aplikasi.
- [ ] Test RLS gagal-aman bila `app.tenant_id` tidak di-set.
- [ ] MFA aktif untuk akun admin.
- [ ] Test login Google: akun tanpa undangan ditolak, `nonce`/`state` salah ditolak, penautan memakai `sub`.
- [ ] Menonaktifkan user mencabut seluruh sesinya seketika.
- [ ] Audit chain terverifikasi; upaya update/delete ditolak.
- [ ] Tidak ada secret di repository (secret scanning lulus).
- [ ] HIPAA gap assessment selesai (bukan klaim kepatuhan).
- [ ] Project Owner menyetujui Stage 3.

## 6. Open Decision

- **OD-011** — CMEK.
- **OD-023** — Masa simpan audit log.
- **OD-024** — Kebijakan MFA untuk dokter (wajib / opsional / per tenant).
