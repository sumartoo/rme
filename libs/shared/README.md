# @clinicrme/shared (type:util)

Utilitas lintas modul tanpa akses database: konfigurasi tervalidasi (`loadConfig`), konteks request (AsyncLocalStorage),
kriptografi (token, AES-256-GCM, HMAC, PKCE), format error RFC 9457 (`Problem`, `ProblemFilter`), dekorator akses
(`@Public`, `@Infra`, `@Authenticated`, `@RequirePermission`, `@AllowWithoutMfa`), validasi body (`@BodySchema`, `@NoBody`),
pemeriksaan saat start (`assertRouteDeclarations`), dan daftar redaksi log (`@clinicrme/shared/logging`).
