import { als } from '@clinicrme/shared';
import { Db } from './db';

describe('Db (SC-TEN-02)', () => {
  // Pool dibuat tanpa koneksi: uji ini membuktikan penolakan terjadi SEBELUM query apa pun dikirim.
  const db = new Db({ url: 'postgres://tidak-dipakai@127.0.0.1:1/x', poolMax: 1 });
  afterAll(() => db.close());

  it('withTenantTx di luar request context ditolak', async () => {
    await expect(db.withTenantTx(async () => 1)).rejects.toThrow(/context/i);
  });

  it('withTenantTx tanpa tenant di context ditolak (fail-closed)', async () => {
    await expect(als.run({ requestId: 'r1' }, () => db.withTenantTx(async () => 1))).rejects.toThrow(/fail-closed/);
  });
});
