# @clinicrme/db (type:data)

Satu-satunya pintu ke PostgreSQL. `Db.withTenantTx` (tenant dari sesi, fail-closed), `Db.withTenant` (pra-autentikasi),
`Db.preAuth` (fungsi SECURITY DEFINER sempit), `audit()` (hash chain), dan `runMigrations` (Drizzle Kit + penolakan
migrasi yang sudah diterapkan tetapi diubah). Modul lain dilarang mengimpor `pg` langsung (lint).
