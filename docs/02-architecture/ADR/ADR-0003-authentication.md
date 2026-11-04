# ADR-0003 — Autentikasi: Google Sign-In + Email/Password di NestJS

| | |
|---|---|
| Status | Accepted — disetujui PO 3 Nov 2026 |
| Tanggal | 3 November 2026 |
| Menyelesaikan | OD-010 |

## Konteks

Staf klinik ingin bisa login dengan akun Google. Pilihan yang dipertimbangkan:

| Opsi | Ringkasan |
|---|---|
| A. Langsung di NestJS | `openid-client` untuk Google OIDC + login password sendiri |
| B. Google Identity Platform / Firebase Auth | Managed, mendukung banyak provider & MFA, berbayar di atas kuota |
| C. Keycloak self-host | Lengkap, tetapi perlu dioperasikan sendiri |

## Keputusan

**Opsi A — sederhana dulu.** NestJS menangani:

1. **Google Sign-In** — OAuth 2.0 Authorization Code + PKCE, scope `openid email profile`, verifikasi `id_token` (signature JWKS, `iss`, `aud`, `exp`, `nonce`, `email_verified`).
2. **Email + password** — hash Argon2id, lockout setelah percobaan gagal, reset via email bertoken.
3. **MFA TOTP** — wajib untuk role admin tenant & platform; konfigurabel untuk klinisi.
4. **Sesi** — web: cookie `HttpOnly`/`Secure`/`SameSite=Lax` yang menunjuk ke baris `user_session`; Android (Stage 13): access token pendek + refresh token rotasi per device.

## Aturan

- Akun **tidak** dibuat otomatis dari login Google; harus ada `user_invitation` aktif.
- Penautan memakai `sub` Google, bukan email.
- Tenant dapat membatasi login Google ke domain Workspace (`hd`).
- Nonaktif di ClinicRME = semua sesi dicabut, tidak bergantung pada akun Google.
- Otorisasi (tenant, cabang, role, permission, jadwal jaga) sepenuhnya dari database ClinicRME.
- Semua login, gagal login, penautan, reset password, dan perubahan MFA tercatat di audit log.

## Konsekuensi

**Positif:** tanpa biaya & komponen tambahan; kontrol penuh atas alur.

**Negatif:** reset password, lockout, dan MFA dibuat & dirawat sendiri; perlu test keamanan yang baik (Stage 3).

**Jalan keluar:** tabel `user_identity` mendukung banyak provider, sehingga migrasi ke IdP (opsi B/C) di masa depan tidak mengubah model user.

## Prasyarat Operasional

- OAuth client Google terpisah per lingkungan (dev/staging/prod) dengan redirect URI yang tepat.
- OAuth consent screen dengan nama & logo ClinicRME; verifikasi brand Google sebelum produksi.
- Client secret di Secret Manager.
