# @clinicrme/platform (type:feature, scope:platform)

Konsol platform SaaS (Stage 5, CR-0001), dilayani hanya di host `admin.<BASE_DOMAIN>`:
login pengguna platform (password + TOTP wajib, cookie `crme_psession`), daftar/detail/pembuatan tenant
(`app.provision_tenant`), mesin status tenant, feature flag, paket. Memakai `PlatformDb` (role DB
`clinicrme_platform`, tanpa akses tabel klinis — PLT-FR-009). Dijaga suite `apps/api/test-integration/platform.e2e-spec.ts`.
