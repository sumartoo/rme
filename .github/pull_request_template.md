## Ringkasan

<!-- Apa yang berubah dan mengapa. -->

**Requirement:** <!-- mis. IAM-FR-003, AC-IAM-FR-003-2 -->

## Checklist

- [ ] Commit mengikuti Conventional Commits dan menyebut ID requirement
- [ ] Uji ditambah/diubah (unit, integrasi, atau SQL) dan lulus lokal
- [ ] Endpoint baru: `@RequirePermission`/`@Public`/`@Authenticated` + `@BodySchema`/`@NoBody`, dan cocok dengan `api/openapi.yaml`
- [ ] Perubahan skema = migrasi baru di `db/migrations/` (migrasi lama tidak diubah)
- [ ] Tidak ada data pasien asli, secret, atau PHI di kode, uji, maupun log
- [ ] Dokumen terkait diperbarui (SRS/RTM/SECURITY_CONTROLS) bila perilaku berubah
