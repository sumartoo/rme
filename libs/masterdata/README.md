# @clinicrme/masterdata (type:feature, scope:masterdata)

Master data klinik (Stage 7, MST-FR-*): fasilitas, cabang, poli/unit, tenaga kesehatan, layanan, tarif berperiode
(tidak pernah ditimpa — trigger `tariff_guard`), penjamin + kontrak, satuan & konversi (tidak melingkar), supplier. Setiap perubahan teraudit dengan nilai sebelum/sesudah
(MST-FR-009); NIK tenaga kesehatan disimpan terenkripsi + HMAC dan tidak pernah dikembalikan utuh maupun masuk audit.
Dijaga suite `apps/api/test-integration/masterdata.e2e-spec.ts` (M##).
