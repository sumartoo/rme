import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Problem } from './problem';
import { toProblem } from './problem.filter';

describe('toProblem', () => {
  it('Problem diteruskan apa adanya', () => {
    expect(toProblem(new Problem(403, 'IAM-403-FORBIDDEN', 'Tidak memiliki izin'))).toEqual({
      type: 'about:blank', title: 'Tidak memiliki izin', status: 403, code: 'IAM-403-FORBIDDEN',
    });
  });

  it('HttpException bawaan Nest → kode GEN-<status>, tanpa pesan internal', () => {
    expect(toProblem(new NotFoundException('Cannot GET /x'))).toMatchObject({ status: 404, code: 'GEN-404' });
    expect(toProblem(new BadRequestException())).toMatchObject({ status: 400, code: 'GEN-400' });
  });

  it('error tak terduga → 500 generik tanpa pesan asli', () => {
    const p = toProblem(new Error('password=rahasia host=10.0.0.5'));
    expect(p).toEqual({ type: 'about:blank', title: 'Terjadi kesalahan pada server', status: 500, code: 'GEN-500' });
  });

  it('error body-parser (ukuran) → 413', () => {
    expect(toProblem({ status: 413, type: 'entity.too.large' })).toMatchObject({ status: 413, code: 'GEN-413' });
  });

  it('aturan database (SQLSTATE kustom) → problem bermakna; dibungkus Drizzle tetap dikenali', () => {
    const quota = { message: 'Failed query', cause: { code: 'CRQ01', message: 'PLT-403-QUOTA: batas user aktif paket (2) tercapai' } };
    expect(toProblem(quota)).toEqual({ type: 'about:blank', title: 'batas user aktif paket (2) tercapai', status: 403, code: 'PLT-403-QUOTA' });
    expect(toProblem({ code: 'CRS01', message: 'PLT-409-STATUS: transisi status TRIAL → TERMINATED tidak diizinkan' }))
      .toMatchObject({ status: 409, code: 'PLT-409-STATUS' });
    expect(toProblem({ code: 'CRP01', message: 'PLT-400-PLAN: paket tidak ditemukan' })).toMatchObject({ status: 400, code: 'PLT-400-PLAN' });
  });

  it('error pg lain tetap 500 generik (tanpa membocorkan pesan SQL)', () => {
    expect(toProblem({ cause: { code: '23505', message: 'duplicate key value violates unique constraint "tenant_code_key"' } }))
      .toEqual({ type: 'about:blank', title: 'Terjadi kesalahan pada server', status: 500, code: 'GEN-500' });
  });
});
