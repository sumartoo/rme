import type { AppConfig } from '@clinicrme/shared';
import { ResolvedSession, SessionService } from './session.service';

const cfg = { sessionIdleMinutes: 30, sessionAbsoluteHours: 12, cookieSecure: true } as AppConfig;
const svc = new SessionService(cfg, {} as never);
const T = 'aaaaaaaa-0000-0000-0000-000000000000';
const session = (o: Partial<ResolvedSession> = {}): ResolvedSession => ({
  session_id: 's', tenant_id: T, user_id: 'u', branch_id: null, mfa_verified: true,
  last_seen_at: new Date(), expires_at: new Date(Date.now() + 3600_000), revoked_at: null, user_status: 'ACTIVE', ...o,
});

describe('SessionService.isUsable (SC-AUTH-06/07, SC-TEN-01)', () => {
  it('sesi valid', () => expect(svc.isUsable(session(), T)).toEqual({ ok: true }));
  it('tenant sesi ≠ subdomain', () => expect(svc.isUsable(session(), 'bbbbbbbb-0000-0000-0000-000000000000')).toEqual({ ok: false, reason: 'TENANT_MISMATCH' }));
  it('tanpa tenant host', () => expect(svc.isUsable(session(), undefined)).toEqual({ ok: false, reason: 'TENANT_MISMATCH' }));
  it('dicabut', () => expect(svc.isUsable(session({ revoked_at: new Date() }), T)).toMatchObject({ reason: 'REVOKED' }));
  it('batas absolut 12 jam lewat', () => expect(svc.isUsable(session({ expires_at: new Date(Date.now() - 1) }), T)).toMatchObject({ reason: 'EXPIRED' }));
  it('idle > 30 menit', () => expect(svc.isUsable(session({ last_seen_at: new Date(Date.now() - 31 * 60_000) }), T)).toMatchObject({ reason: 'IDLE_TIMEOUT' }));
  it('idle tepat di bawah batas masih berlaku', () => expect(svc.isUsable(session({ last_seen_at: new Date(Date.now() - 29 * 60_000) }), T)).toEqual({ ok: true }));
  it('user nonaktif', () => expect(svc.isUsable(session({ user_status: 'DISABLED' }), T)).toMatchObject({ reason: 'USER_DISABLED' }));
});
