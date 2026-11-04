import { acceptTotpStep } from './totp';

describe('anti-replay TOTP (RSK-024)', () => {
  const now = 1_793_900_000_000;            // langkah = floor(now/30000)
  const step = Math.floor(now / 30_000);
  it('kode salah → null', () => expect(acceptTotpStep(null, null, now)).toBeNull());
  it('pertama kali → langkah saat ini', () => expect(acceptTotpStep(0, null, now)).toBe(step));
  it('langkah sama dipakai ulang → ditolak', () => expect(acceptTotpStep(0, String(step), now)).toBeNull());
  it('kode lama dalam toleransi (delta -1) setelah langkah ini → ditolak', () => expect(acceptTotpStep(-1, step, now)).toBeNull());
  it('periode berikutnya → diterima', () => expect(acceptTotpStep(0, step, now + 30_000)).toBe(step + 1));
});
