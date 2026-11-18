import { problem } from './http/problem';

/**
 * Pembatas laju aplikasi (Stage 15, OD-137 / DEC-050) — jendela tetap di memori proses.
 *
 * Batas berlaku **per instance** Cloud Run: dengan N instance, batas efektif maksimal N × nilai. Lapisan utama pembatasan per IP ada di
 * Cloud Armor (alamat klien akurat di tepi jaringan); lapisan ini melindungi dari satu pengguna/tenant yang membanjiri API dan dari
 * tebakan password berulang untuk satu akun dari satu alamat. Kunci tidak berisi data pasien.
 */
export interface RateLimitConfig { enabled: boolean; loginPerMinute: number; userPerMinute: number; tenantPerMinute: number; exportPerHour: number }
export const RATE_LIMITER = Symbol('RATE_LIMITER');

const MAX_KEYS = 50_000;

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(readonly cfg: RateLimitConfig, private readonly now: () => number = Date.now) {}

  /** Mencatat satu permintaan. `ok=false` bila melewati batas; `retryAfter` dalam detik. */
  hit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfter: number; remaining: number } {
    if (!this.cfg.enabled) return { ok: true, retryAfter: 0, remaining: limit };
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= windowMs) {
      if (this.windows.size >= MAX_KEYS) this.sweep(t, windowMs);
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    const retryAfter = Math.max(1, Math.ceil((w.start + windowMs - t) / 1000));
    return { ok: w.count <= limit, retryAfter, remaining: Math.max(0, limit - w.count) };
  }

  /** Lempar 429 (problem+json) dengan header Retry-After bila batas terlampaui. */
  enforce(key: string, limit: number, windowMs: number, res: { setHeader(name: string, value: string): unknown } | undefined, what: string) {
    const r = this.hit(key, limit, windowMs);
    if (r.ok) return;
    res?.setHeader('Retry-After', String(r.retryAfter));
    throw problem(429, 'GEN-429-RATE-LIMIT', `Terlalu banyak permintaan (${what}). Coba lagi dalam ${r.retryAfter} detik.`);
  }

  private sweep(t: number, windowMs: number) {
    for (const [k, w] of this.windows) if (t - w.start >= windowMs) this.windows.delete(k);
    // Masih penuh (serangan dengan banyak kunci): buang yang tertua agar memori tetap terbatas
    if (this.windows.size >= MAX_KEYS) {
      let n = Math.ceil(MAX_KEYS / 10);
      for (const k of this.windows.keys()) { this.windows.delete(k); if (--n === 0) break; }
    }
  }
}
