import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { StorageConfig, storageConfigFromEnv } from '@clinicrme/storage';

/**
 * Konfigurasi aplikasi dari environment (12-factor). Divalidasi saat start: nilai salah → proses berhenti.
 * Di staging/produksi semua secret berasal dari Secret Manager yang di-mount sebagai env (SC-CRY-04).
 */
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (def: number, min = 1) => z.coerce.number().int().min(min).default(def);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'test', 'dev', 'staging', 'prod']).default('local'),
  PORT: int(3000),
  /** Koneksi aplikasi: role LOGIN yang hanya anggota clinicrme_app (NOBYPASSRLS, bukan owner). */
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: int(10),
  /** Koneksi konsol platform: role LOGIN anggota clinicrme_platform (tanpa akses tabel klinis — PLT-FR-009, CR-0001). */
  PLATFORM_DATABASE_URL: z.string().url(),
  PLATFORM_DB_POOL_MAX: int(4),
  BASE_DOMAIN: z.string().min(3).default('clinicrme.test'),
  SESSION_IDLE_MINUTES: int(30),
  SESSION_ABSOLUTE_HOURS: int(12),
  LOCKOUT_THRESHOLD: int(5),
  LOCKOUT_MINUTES: int(15),
  MFA_MAX_ATTEMPTS: int(5),
  // Zod 4: prefault = nilai default yang tetap melewati transform (default() melewatinya → string 'true')
  COOKIE_SECURE: bool.prefault('true'),
  BODY_LIMIT: z.string().regex(/^\d+(kb|mb)$/).default('1mb'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** 32 byte hex. Lokal/test saja; di cloud kunci data dibungkus Cloud KMS (SC-CRY-03, Stage 15). */
  ENCRYPTION_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY_HEX harus 64 karakter hex'),
  GOOGLE_ISSUER: z.string().url().default('https://accounts.google.com'),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),
  /** Masa berlaku tautan unduh ekspor tenant (AC-PLT-FR-008-1, default 24 jam). */
  EXPORT_TTL_HOURS: int(24).pipe(z.number().max(168)),
  /** Payment gateway QRIS (OD-039). Hanya simulator sampai penyedia nyata dipilih sebelum pilot. */
  PAYMENT_GATEWAY: z.enum(['SIMULATOR']).default('SIMULATOR'),
  /** Kunci HMAC callback simulator (≥ 32 karakter). Wajib di staging; lingkungan lain: diturunkan dari ENCRYPTION_KEY_HEX bila kosong. */
  PAYMENT_SIMULATOR_SECRET: z.string().min(32).optional(),
  QRIS_EXPIRY_MINUTES: int(15).pipe(z.number().max(120)),
  /** SATUSEHAT (Stage 12): alamat resmi Kemenkes; diganti hanya untuk uji klien HTTP. */
  SATUSEHAT_SANDBOX_URL: z.string().url().default('https://api-satusehat-stg.dto.kemkes.go.id'),
  SATUSEHAT_PRODUCTION_URL: z.string().url().default('https://api-satusehat.kemkes.go.id'),
});

export interface AppConfig {
  env: z.infer<typeof EnvSchema>['NODE_ENV'];
  appEnv: z.infer<typeof EnvSchema>['APP_ENV'];
  port: number;
  db: { url: string; poolMax: number };
  platformDb: { url: string; poolMax: number };
  baseDomain: string;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  lockoutThreshold: number;
  lockoutMinutes: number;
  mfaMaxAttempts: number;
  cookieSecure: boolean;
  bodyLimit: string;
  logLevel: string;
  encryptionKeyHex: string;
  google: { issuer: string; clientId: string; clientSecret: string; redirectUri: string };
  storage: StorageConfig;
  exportTtlHours: number;
  paymentGateway: { provider: 'SIMULATOR'; secret: string; qrisExpiryMinutes: number };
  satusehatUrls: { sandbox: string; production: string };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const r = EnvSchema.safeParse(env);
  if (!r.success) {
    // Nama variabel saja yang ditampilkan — tidak pernah nilainya.
    const fields = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Konfigurasi tidak valid — ${fields}`);
  }
  const e = r.data;
  if (e.APP_ENV !== 'local' && e.APP_ENV !== 'test' && !e.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE wajib true di luar lingkungan local/test');
  }
  if (e.APP_ENV === 'prod' && e.PAYMENT_GATEWAY === 'SIMULATOR') {
    throw new Error('PAYMENT_GATEWAY=SIMULATOR tidak boleh dipakai di produksi (OD-039)');
  }
  if (e.APP_ENV === 'staging' && !e.PAYMENT_SIMULATOR_SECRET) {
    throw new Error('PAYMENT_SIMULATOR_SECRET wajib di staging');
  }
  return {
    env: e.NODE_ENV,
    appEnv: e.APP_ENV,
    port: e.PORT,
    db: { url: e.DATABASE_URL, poolMax: e.DB_POOL_MAX },
    platformDb: { url: e.PLATFORM_DATABASE_URL, poolMax: e.PLATFORM_DB_POOL_MAX },
    baseDomain: e.BASE_DOMAIN,
    sessionIdleMinutes: e.SESSION_IDLE_MINUTES,
    sessionAbsoluteHours: e.SESSION_ABSOLUTE_HOURS,
    lockoutThreshold: e.LOCKOUT_THRESHOLD,
    lockoutMinutes: e.LOCKOUT_MINUTES,
    mfaMaxAttempts: e.MFA_MAX_ATTEMPTS,
    cookieSecure: e.COOKIE_SECURE,
    bodyLimit: e.BODY_LIMIT,
    logLevel: e.LOG_LEVEL,
    encryptionKeyHex: e.ENCRYPTION_KEY_HEX,
    google: {
      issuer: e.GOOGLE_ISSUER,
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      redirectUri: e.GOOGLE_REDIRECT_URI,
    },
    storage: storageConfigFromEnv(env, e.APP_ENV),
    exportTtlHours: e.EXPORT_TTL_HOURS,
    paymentGateway: {
      provider: e.PAYMENT_GATEWAY,
      secret: e.PAYMENT_SIMULATOR_SECRET ?? createHmac('sha256', e.ENCRYPTION_KEY_HEX).update('payment-simulator').digest('hex'),
      qrisExpiryMinutes: e.QRIS_EXPIRY_MINUTES,
    },
    satusehatUrls: { sandbox: e.SATUSEHAT_SANDBOX_URL, production: e.SATUSEHAT_PRODUCTION_URL },
  };
}

export const CONFIG = Symbol('CONFIG');
