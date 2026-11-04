-- ClinicRME — migrasi 0009 (Stage 6 batch 2): menu "Log audit" ditarik sampai halaman & API pencarian audit
-- (AUD-FR-004, auditSearch) dibangun — menu tidak boleh menautkan halaman yang belum ada.
SET search_path = app, public;
DELETE FROM menu_item WHERE code = 'admin.audit';
