# Stage 6 — Identity, Role, Permission & Dynamic Menu

| | |
|---|---|
| Phase | C — Platform SaaS |
| Status | **Berjalan** sejak 4 Nov 2026 (DEC-028) — rencana: `docs/reports/stage-6/STAGE_PLAN.md` |
| Prasyarat | Stage 5 disetujui |
| Modul | `iam` |

## 1. Tujuan

Menyediakan administrasi pengguna yang fleksibel dan aman, dengan otorisasi yang ditegakkan di backend.

## 2. Ruang Lingkup

- Pengelolaan akun (buat, undang, nonaktifkan, reset).
- Role konfigurabel dari kumpulan permission + role template bawaan.
- Dynamic sidebar/menu berdasarkan permission.
- Role bawaan: dokter, perawat, pendaftaran, farmasi, kasir, admin, manajer, auditor.
- Penugasan user ke klinik & cabang.
- Jadwal login berdasarkan hari & jam jaga.
- Pembatasan akses berdasarkan fasilitas & status akun.
- Session & device management (lihat, cabut).
- MFA untuk akun administratif.
- Delegasi akses sementara dengan audit.

## 3. Rancangan

### 3.1 Tabel Inti

| Tabel | Keterangan |
|---|---|
| `app_user` | tenant_id, username, email, phone, status, practitioner_id (opsional), mfa_enabled |
| `permission` | code (global, dikelola sistem), module, description |
| `role` | tenant_id, code, name, is_template |
| `role_permission` | role_id, permission_code |
| `user_role_assignment` | user_id, role_id, branch_id (nullable = semua cabang), valid_from, valid_to |
| `login_schedule` | user_id / role_id, day_of_week, start_time, end_time, branch_id |
| `access_delegation` | from_user, to_user, permissions, valid_from, valid_to, reason, approved_by |
| `user_session` | user_id, device, ip, created_at, last_seen_at, revoked_at |
| `menu_item` | code, parent_code, label, route, icon, required_permission, order |

### 3.2 Dynamic Menu

```
GET /api/v1/me/menu
→ backend menghitung permission efektif user di cabang aktif
→ menyaring menu_item berdasarkan required_permission
→ mengembalikan pohon menu
```

Frontend hanya menampilkan; semua endpoint tetap memeriksa permission sendiri (dekorator NestJS `@RequirePermission('clinical.note.sign')` + `PermissionGuard` global yang menolak endpoint tanpa dekorator).

### 3.3 Konteks Cabang

User yang ditugaskan ke beberapa cabang memilih **cabang aktif** saat login; cabang aktif masuk ke token/sesi dan menjadi filter tambahan di atas tenant.

## 4. Requirement Awal

| ID | Ringkasan |
|---|---|
| IAM-FR-001 | Tenant admin membuat role custom dari daftar permission |
| IAM-FR-002 | Menu tampil sesuai permission efektif |
| IAM-FR-003 | Login ditolak di luar jadwal jaga bila jadwal diaktifkan |
| IAM-FR-004 | User dapat melihat & mencabut sesi aktif |
| IAM-FR-005 | Delegasi akses berbatas waktu dan teraudit |
| IAM-FR-006 | MFA wajib untuk role admin |

## 5. Deliverable

Modul `iam`, migrasi, OpenAPI, layar user/role/menu, matriks permission (`docs/03-security/PERMISSION_MATRIX.md`), test, completion report.

## 6. Gate Checklist

- [ ] Test otomatis: setiap endpoint menolak user tanpa permission (permission matrix test).
- [ ] Menu frontend bukan satu-satunya kontrol akses (dibuktikan dengan test API langsung).
- [ ] Jadwal login & status akun ditegakkan.
- [ ] Delegasi kedaluwarsa otomatis.
- [ ] Project Owner menyetujui Stage 6.

## 7. Open Decision

- **OD-029** — Perilaku sesi yang sedang aktif saat jam jaga berakhir (paksa logout vs peringatan).
