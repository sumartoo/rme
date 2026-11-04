import { AUDIT_CHAIN_VERIFY, AUDIT_PARTITIONS, HEARTBEAT, JobDeps, findJob, jobs } from './jobs';

const deps = (rows: object[], appEnv = 'prod') => {
  const calls: { text: string; params?: unknown[] }[] = [];
  const warnings: object[] = [];
  const d: JobDeps = {
    query: async (text, params) => { calls.push({ text, params }); return rows as never; },
    appEnv,
    warn: (o) => warnings.push(o),
    // Job ekspor diuji end-to-end di apps/api/test-integration (K05–K07); di sini tidak dipakai
    pool: {} as never, storage: {} as never, exportOptions: { encryptionKeyHex: 'b'.repeat(64), ttlHours: 24 },
    notifyOptions: { clinicUrlTemplate: 'http://{code}.localhost:4200' },
  };
  return { d, calls, warnings };
};

describe('registri job', () => {
  it('nama job unik dan berformat <domain>.<aksi>', () => {
    const names = jobs.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
  });

  it('heartbeat mengembalikan nonce tanpa menyentuh database', async () => {
    const { d, calls } = deps([]);
    const r = await findJob(HEARTBEAT)!.handler({ nonce: 'n-1' }, d);
    expect(r).toMatchObject({ ok: true, echo: 'n-1' });
    expect(calls).toHaveLength(0);
  });
});

describe('system.audit_partitions', () => {
  const job = findJob(AUDIT_PARTITIONS)!;

  it('terjadwal harian dan berjalan saat start', () => {
    expect(job.cron).toBe('17 0 * * *');
    expect(job.runOnStart).toBe(true);
  });

  it('memanggil ensure_audit_partitions(2) dengan parameter terikat', async () => {
    const { d, calls } = deps([{ partition_name: 'audit_log_2026_11', status: 'EXISTS' }]);
    await job.handler(null, d);
    expect(calls).toEqual([{ text: 'select partition_name, status from app.ensure_audit_partitions($1)', params: [2] }]);
  });

  it('di cloud, bulan yang terlewat membuat job GAGAL (agar memicu alert)', async () => {
    const { d } = deps([{ partition_name: 'audit_log_2026_11', status: 'SKIPPED_DEFAULT_HAS_ROWS' }], 'prod');
    await expect(job.handler(null, d)).rejects.toThrow(/audit_log_2026_11/);
  });

  it('di lokal, bulan yang terlewat hanya peringatan', async () => {
    const { d, warnings } = deps([{ partition_name: 'audit_log_2026_11', status: 'SKIPPED_DEFAULT_HAS_ROWS' }], 'local');
    await expect(job.handler(null, d)).resolves.toBeDefined();
    expect(warnings).toEqual([{ skipped: ['audit_log_2026_11'] }]);
  });
});

describe('system.audit_chain_verify (SC-AUD-03)', () => {
  const job = findJob(AUDIT_CHAIN_VERIFY)!;

  it('terjadwal harian, tanpa retry (kegagalan harus terlihat, bukan diulang diam-diam)', () => {
    expect(job.cron).toBe('47 1 * * *');
    expect(job.retryLimit).toBe(0);
  });

  it('semua rantai utuh → jumlah tenant terverifikasi', async () => {
    const { d } = deps([{ tenant_id: 'a', ok: true, first_bad_seq: null }, { tenant_id: 'b', ok: true, first_bad_seq: null }]);
    await expect(job.handler(null, d)).resolves.toEqual({ tenantsVerified: 2 });
  });

  it('ada rantai rusak → job GAGAL dan menyebut tenant & seq pertama yang rusak', async () => {
    const { d } = deps([{ tenant_id: 'a', ok: true, first_bad_seq: null }, { tenant_id: 'b', ok: false, first_bad_seq: '42' }]);
    await expect(job.handler(null, d)).rejects.toThrow(/b@seq 42/);
  });
});

describe('notify.outbox.dispatch', () => {
  it('tanpa SMTP: tidak menyentuh database, memberi peringatan', async () => {
    const { d, calls, warnings } = deps([]);
    expect(await findJob('notify.outbox.dispatch')!.handler(null, d)).toEqual({ skipped: true });
    expect(calls).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });
});
