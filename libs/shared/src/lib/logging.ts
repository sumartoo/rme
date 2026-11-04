/**
 * Kebijakan log (SC-LOG-01): JSON terstruktur, tanpa PHI dan tanpa secret.
 * - Body request/response TIDAK pernah dicatat oleh logger HTTP; URL dicatat tanpa query string
 *   (query OAuth membawa `code`/`state`).
 * - Header & field berikut diganti "[REDACTED]" bila muncul di tingkat atas atau satu tingkat di dalam
 *   objek log (batas wildcard pino). Jangan pernah mencatat objek domain (pasien, catatan klinis) utuh.
 * Daftar ini dipakai oleh logger api & worker; uji di logging.spec.ts.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.password_hash',
  '*.passwordHash',
  '*.token',
  '*.id_token',
  '*.access_token',
  '*.code_verifier',
  '*.nik',
  '*.totp_secret',
  '*.recoveryCodes',
  '*.soap',
  '*.subjective',
  '*.objective',
  '*.assessment',
  '*.plan',
  'password',
  'nik',
  'token',
];

export const REDACT_CENSOR = '[REDACTED]';
