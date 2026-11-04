import { TENANT_STATUSES, allowedTransitions, canTransition } from './tenant-status';

describe('mesin status tenant', () => {
  it('jalur normal: trial → aktif → grace → suspended → terminated', () => {
    expect(canTransition('TRIAL', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'GRACE')).toBe(true);
    expect(canTransition('GRACE', 'SUSPENDED')).toBe(true);
    expect(canTransition('SUSPENDED', 'TERMINATED')).toBe(true);
  });

  it('TERMINATED final dan tidak bisa dicapai tanpa SUSPENDED dulu', () => {
    expect(allowedTransitions('TERMINATED')).toEqual([]);
    for (const s of TENANT_STATUSES) if (s !== 'SUSPENDED') expect(canTransition(s, 'TERMINATED')).toBe(false);
  });

  it('tidak ada transisi ke diri sendiri atau kembali ke PROVISIONING', () => {
    for (const s of TENANT_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
      expect(canTransition(s, 'PROVISIONING')).toBe(false);
    }
  });

  it('pemulihan dari SUSPENDED dan GRACE ke ACTIVE diizinkan', () => {
    expect(canTransition('SUSPENDED', 'ACTIVE')).toBe(true);
    expect(canTransition('GRACE', 'ACTIVE')).toBe(true);
  });
});
