import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Adapter payment gateway QRIS (OD-039). Alur kasir hanya bergantung pada antarmuka ini; penyedia nyata (Midtrans, Xendit,
 * DOKU, …) cukup menambah satu kelas yang mengimplementasikannya setelah dipilih sebelum pilot.
 */
export interface PaymentGateway {
  readonly provider: string;
  /** Buat QR dinamis untuk nominal tertentu. `orderRef` = id transaksi kita (unik). */
  createCharge(input: { orderRef: string; amount: number; expiresAt: Date }): Promise<{ providerRef: string; qrPayload: string }>;
  /** Verifikasi signature callback atas byte mentah body. */
  verifySignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  /** Ubah payload callback menjadi event baku. */
  parseCallback(body: unknown): GatewayEvent | null;
}

export interface GatewayEvent { eventId: string; providerRef: string; status: 'PAID' | 'EXPIRED' | 'FAILED'; amount: number; paidAt: Date | null }

export const SimulatorCallback = z.object({
  eventId: z.string().min(1).max(100),
  providerRef: z.string().regex(/^SIM-[0-9A-F]{20}$/),
  status: z.enum(['PAID', 'EXPIRED', 'FAILED']),
  amount: z.number().positive().max(1_000_000_000),
  paidAt: z.string().datetime({ offset: true }).optional(),
}).strict();

/**
 * Simulator bawaan (bukan penyedia nyata, tanpa biaya): QR berformat EMV-mirip bertanda SIMULASI, callback ditandatangani
 * HMAC-SHA256 heksadesimal di header `X-Signature`, berkas settlement CSV `provider_ref,amount,settled_at`.
 * Ditolak di produksi oleh konfigurasi.
 */
export class SimulatorGateway implements PaymentGateway {
  readonly provider = 'SIMULATOR';
  constructor(private readonly secret: string) {}

  async createCharge(input: { orderRef: string; amount: number; expiresAt: Date }) {
    const providerRef = `SIM-${randomBytes(10).toString('hex').toUpperCase()}`;
    const amount = input.amount.toFixed(2);
    const qrPayload = `00020101021226SIMULASI.QRIS.CLINICRME01${providerRef}5303360540${amount.length}${amount}5802ID6304SIMQ`;
    return { providerRef, qrPayload };
  }

  sign(rawBody: Buffer | string): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  verifySignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const got = headers['x-signature'];
    if (typeof got !== 'string' || !/^[0-9a-f]{64}$/.test(got)) return false;
    const want = Buffer.from(this.sign(rawBody), 'hex');
    return timingSafeEqual(want, Buffer.from(got, 'hex'));
  }

  parseCallback(body: unknown): GatewayEvent | null {
    const p = SimulatorCallback.safeParse(body);
    if (!p.success) return null;
    return { eventId: p.data.eventId, providerRef: p.data.providerRef, status: p.data.status, amount: p.data.amount,
      paidAt: p.data.paidAt ? new Date(p.data.paidAt) : null };
  }
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** Baris settlement CSV: `provider_ref,amount,settled_at` (header opsional). Baris rusak → error dengan nomor baris. */
export function parseSettlementCsv(text: string): { providerRef: string; amount: number; settledAt: string | null }[] {
  const out: { providerRef: string; amount: number; settledAt: string | null }[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || (i === 0 && /^provider_ref\s*,/i.test(line))) return;
    const [ref, amt, at] = line.split(',').map((x) => x.trim());
    const amount = Number(amt);
    if (!ref || !/^[A-Za-z0-9._-]{4,64}$/.test(ref) || !Number.isFinite(amount) || amount <= 0) throw new Error(`Baris ${i + 1} tidak valid`);
    if (at && Number.isNaN(Date.parse(at))) throw new Error(`Baris ${i + 1}: waktu settlement tidak valid`);
    out.push({ providerRef: ref, amount: Math.round(amount * 100) / 100, settledAt: at || null });
  });
  return out;
}
