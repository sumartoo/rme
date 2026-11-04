-- ClinicRME — migrasi 0007 (Stage 6 batch 1): anti-replay TOTP (RSK-024, SC-AUTH-05/09).
-- Menyimpan langkah waktu TOTP (periode 30 detik) terakhir yang berhasil; kode dari langkah yang sama atau
-- lebih lama ditolak, sehingga kode yang tersadap/terlihat tidak dapat dipakai ulang dalam periodenya.
SET search_path = app, public;

ALTER TABLE user_mfa ADD COLUMN last_totp_step bigint;
ALTER TABLE platform_mfa ADD COLUMN last_totp_step bigint;
COMMENT ON COLUMN user_mfa.last_totp_step IS 'floor(unix/30) kode TOTP terakhir yang diterima (anti-replay, RSK-024)';
COMMENT ON COLUMN platform_mfa.last_totp_step IS 'floor(unix/30) kode TOTP terakhir yang diterima (anti-replay, RSK-024)';
