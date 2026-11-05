import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ProblemBody } from './problem';

/**
 * Semua error keluar sebagai application/problem+json. Error tak terduga → 500 tanpa detail
 * (stack hanya di log server, tanpa PHI — SC-LOG-01).
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('ProblemFilter');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const body = toProblem(err);
    if (body.status >= 500) this.log.error({ err, path: req.path }, 'Unhandled error');
    if (res.headersSent) return;
    res.status(body.status).type('application/problem+json').json(body);
  }
}

export function toProblem(err: unknown): ProblemBody {
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const r = err.getResponse();
    if (typeof r === 'object' && r && 'code' in r) return r as ProblemBody;
    const title = typeof r === 'string' ? r : status === 404 ? 'Tidak ditemukan' : status === 400 ? 'Permintaan tidak valid' : 'Permintaan ditolak';
    return { type: 'about:blank', title, status, code: `GEN-${status}` };
  }
  // Pelanggaran aturan bisnis yang ditegakkan di database (SQLSTATE kustom, lihat migrasi 0003)
  const pg = pgError(err);
  if (pg?.code && DB_RULES[pg.code]) return DB_RULES[pg.code](pg.message ?? '');
  // Error body-parser Express (ukuran, JSON rusak) membawa status 4xx
  const e = err as { status?: number; type?: string };
  if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
    if (e.type === 'entity.too.large') return { type: 'about:blank', title: 'Body terlalu besar', status: 413, code: 'GEN-413' };
    return { type: 'about:blank', title: 'Body tidak valid', status: e.status, code: `GEN-${e.status}` };
  }
  return { type: 'about:blank', title: 'Terjadi kesalahan pada server', status: 500, code: 'GEN-500' };
}

/** SQLSTATE kustom → problem. Pesan diambil dari teks setelah kode (tanpa detail baris/PHI). */
const DB_RULES: Record<string, (msg: string) => ProblemBody> = {
  CRQ01: (m) => ({ type: 'about:blank', title: tail(m, 'Batas paket tercapai'), status: 403, code: 'PLT-403-QUOTA' }),
  CRS01: (m) => ({ type: 'about:blank', title: tail(m, 'Transisi status tidak diizinkan'), status: 409, code: 'PLT-409-STATUS' }),
  CRG01: (m) => ({ type: 'about:blank', title: tail(m, 'Akses dukungan tidak berlaku'), status: 403, code: 'PLT-403-GRANT' }),
  CRM01: (m) => ({ type: 'about:blank', title: tail(m, 'Data master tidak dapat diubah'), status: 409, code: m.split(':')[0] || 'MST-409' }),
  // Exclusion constraint (mis. periode tarif tumpang tindih) → 409
  '23P01': () => ({ type: 'about:blank', title: 'Periode bertabrakan dengan data yang sudah ada', status: 409, code: 'MST-409-OVERLAP' }),
  CRP01: (m) => ({ type: 'about:blank', title: tail(m, 'Data provisioning tidak valid'), status: 400, code: m.split(':')[0] || 'PLT-400' }),
};

function tail(msg: string, fallback: string) {
  const i = msg.indexOf(': ');
  return i > 0 ? msg.slice(i + 2) : fallback;
}

/** Drizzle membungkus error pg (DrizzleQueryError.cause); pg mentah juga diterima. */
export function pgError(err: unknown): { code?: string; message?: string; constraint?: string } | undefined {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, i = 0; e && i < 3; e = e.cause as typeof e, i++) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e as { code: string; message?: string; constraint?: string };
  }
  return undefined;
}
