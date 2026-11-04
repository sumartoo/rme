# @clinicrme/iam (type:feature, scope:iam)

Autentikasi (password Argon2id, Google OIDC + PKCE, TOTP), sesi server-side, tenant dari subdomain (`ContextMiddleware`),
dan guard global deny-by-default (`SecurityGuard`). Dipindah dari PoC Stage 3; dijaga oleh suite `apps/api/test-integration`.
Undangan, manajemen user/role, dan menu dinamis: Stage 6.
