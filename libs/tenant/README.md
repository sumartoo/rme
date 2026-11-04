# @clinicrme/tenant (type:feature, scope:tenant)

Administrasi klinik oleh tenant admin (Stage 5): profil & kop surat (`/api/v1/tenant/profile`, If-Match) dan
ekspor seluruh data tenant (`/api/v1/tenant/exports`). Arsip dibuat worker (`@clinicrme/db/tenant-export`), diunduh lewat
API agar setiap unduhan & pengambilan kunci teraudit. Dijaga suite `apps/api/test-integration/tenant-admin.e2e-spec.ts` (T##A).
