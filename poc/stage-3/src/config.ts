/** Konfigurasi PoC. Di produksi semua nilai rahasia berasal dari Secret Manager (SC-CRY-04). */
export interface AppConfig {
  db: { host: string; port: number; database: string; user: string; password?: string };
  baseDomain: string;            // mis. clinicrme.id → tenant dari subdomain
  sessionIdleMinutes: number;    // SC-AUTH-06
  sessionAbsoluteHours: number;
  lockoutThreshold: number;      // SC-AUTH-04
  mfaMaxAttempts: number;        // SC-AUTH-05: kode MFA salah per sesi sebelum sesi dicabut
  lockoutMinutes: number;
  cookieSecure: boolean;
  /** Kunci 32 byte (hex) untuk AES-256-GCM secret TOTP & tanda tangan cookie OIDC. Produksi: Cloud KMS. */
  encryptionKeyHex: string;
  google: { issuer: string; clientId: string; clientSecret: string; redirectUri: string };
}

export function loadConfig(env = process.env): AppConfig {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Konfigurasi ${k} wajib diisi`);
    return v;
  };
  return {
    db: {
      host: env.PGHOST ?? '/tmp',
      port: Number(env.PGPORT ?? 5432),
      database: need('PGDATABASE'),
      user: need('PGUSER'),
      password: env.PGPASSWORD,
    },
    baseDomain: env.BASE_DOMAIN ?? 'clinicrme.test',
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES ?? 30),
    sessionAbsoluteHours: Number(env.SESSION_ABSOLUTE_HOURS ?? 12),
    lockoutThreshold: Number(env.LOCKOUT_THRESHOLD ?? 5),
    mfaMaxAttempts: Number(env.MFA_MAX_ATTEMPTS ?? 5),
    lockoutMinutes: Number(env.LOCKOUT_MINUTES ?? 15),
    cookieSecure: (env.COOKIE_SECURE ?? 'true') === 'true',
    encryptionKeyHex: need('ENCRYPTION_KEY_HEX'),
    google: {
      issuer: need('GOOGLE_ISSUER'),
      clientId: need('GOOGLE_CLIENT_ID'),
      clientSecret: need('GOOGLE_CLIENT_SECRET'),
      redirectUri: need('GOOGLE_REDIRECT_URI'),
    },
  };
}

export const CONFIG = Symbol('CONFIG');
