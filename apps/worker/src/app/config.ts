import { z } from 'zod';

const Schema = z.object({
  APP_ENV: z.enum(['local', 'test', 'dev', 'staging', 'prod']).default('local'),
  /** Koneksi worker. pg-boss membuat & memigrasi skema `pgboss` sendiri saat start (Stage 15: role khusus pemilik skema pgboss). */
  WORKER_DATABASE_URL: z.string().url(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** 1 = kirim job heartbeat ke diri sendiri, tunggu selesai, lalu keluar (smoke test CI). */
  WORKER_SELFTEST: z.enum(['0', '1']).default('0'),
  /** Kunci aplikasi (sama dengan API) — membungkus kunci arsip ekspor. */
  ENCRYPTION_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY_HEX harus 64 karakter hex'),
  EXPORT_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /** Folder kerja sementara ekspor (Cloud Run: /tmp, memori). */
  WORKER_TMP_DIR: z.string().optional(),
  /** smtp://host:port (Mailpit lokal: smtp://localhost:1025) atau smtps://USER:PASS@host:465. Kosong = email tidak dikirim. */   // pragma: allowlist secret — contoh format
  SMTP_URL: z.preprocess((v) => (v === '' ? undefined : v),   // `SMTP_URL=` kosong di .env = email mati
    z.string().regex(/^smtps?:\/\/[^\s]+$/, 'SMTP_URL harus smtp:// atau smtps://').optional()),
  MAIL_FROM: z.string().min(3).default('ClinicRME <no-reply@clinicrme.test>'),
  /** Alamat aplikasi klinik di email; {code} diganti kode tenant. */
  CLINIC_URL_TEMPLATE: z.string().regex(/\{code\}/, 'CLINIC_URL_TEMPLATE harus memuat {code}').default('http://{code}.localhost:4200'),
});

export type WorkerConfig = z.infer<typeof Schema>;

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const r = Schema.safeParse(env);
  if (!r.success) throw new Error(`Konfigurasi worker tidak valid — ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}
