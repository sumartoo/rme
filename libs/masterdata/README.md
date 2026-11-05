# @clinicrme/masterdata (type:feature, scope:masterdata)

Master data klinik (Stage 7, MST-FR-*): fasilitas, cabang, poli/unit, tenaga kesehatan — dan pada batch berikutnya
layanan, tarif, penjamin, satuan, supplier, impor/ekspor. Setiap perubahan teraudit dengan nilai sebelum/sesudah
(MST-FR-009); NIK tenaga kesehatan disimpan terenkripsi + HMAC dan tidak pernah dikembalikan utuh maupun masuk audit.
Dijaga suite `apps/api/test-integration/masterdata.e2e-spec.ts` (M##).
