import { loadWorkerConfig } from './config';

describe('konfigurasi worker', () => {
  it('menolak tanpa WORKER_DATABASE_URL dan tidak menampilkan nilai env lain', () => {
    expect(() => loadWorkerConfig({ LOG_LEVEL: 'info', SECRET_X: 'nilai-rahasia' })).toThrow(/WORKER_DATABASE_URL/); // pragma: allowlist secret — nilai uji sintetis
    try { loadWorkerConfig({ SECRET_X: 'nilai-rahasia' }); } catch (e) { expect(String(e)).not.toContain('nilai-rahasia'); } // pragma: allowlist secret — nilai uji sintetis
  });

  it('nilai default', () => {
    expect(loadWorkerConfig({ WORKER_DATABASE_URL: 'postgres://u@h/db', ENCRYPTION_KEY_HEX: 'b'.repeat(64) }))
      .toMatchObject({ WORKER_CONCURRENCY: 2, WORKER_SELFTEST: '0', EXPORT_TTL_HOURS: 24 });
  });

  it('SMTP_URL kosong = email mati (bukan error); format lain ditolak', () => {
    const base = { WORKER_DATABASE_URL: 'postgres://u@h/db', ENCRYPTION_KEY_HEX: 'b'.repeat(64) };
    expect(loadWorkerConfig({ ...base, SMTP_URL: '' }).SMTP_URL).toBeUndefined();
    expect(loadWorkerConfig({ ...base, SMTP_URL: 'smtp://localhost:1025' }).SMTP_URL).toBe('smtp://localhost:1025');
    expect(() => loadWorkerConfig({ ...base, SMTP_URL: 'http://x' })).toThrow(/SMTP_URL/);
  });

  it('kunci enkripsi wajib (membungkus kunci arsip ekspor)', () => {
    expect(() => loadWorkerConfig({ WORKER_DATABASE_URL: 'postgres://u@h/db' })).toThrow(/ENCRYPTION_KEY_HEX/);
  });
});
