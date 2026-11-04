import { downstreamHeaders, upstreamHeaders, upstreamPath } from '../src/lib/upstream';

describe('penerusan konsol → API (CR-0001)', () => {
  it('hanya path /api/platform/v1 dengan segmen aman; traversal & karakter aneh ditolak', () => {
    expect(upstreamPath(['tenants', 'abc-1'], '?limit=2')).toBe('/api/platform/v1/tenants/abc-1?limit=2');
    expect(upstreamPath(['..', 'v1', 'patients'], '')).toBeNull();
    expect(upstreamPath(['tenants%2F..'], '')).toBeNull();
    expect(upstreamPath([], '')).toBeNull();
  });

  it('Host selalu host konsol; header lain di luar daftar tidak diteruskan', () => {
    const h = upstreamHeaders(new Headers({ host: 'demo.localhost', cookie: 'crme_psession=x', 'x-csrf-token': 't',
                                            authorization: 'Bearer y', 'x-tenant-id': 'z' }), 'admin.localhost', 2);
    expect(h).toEqual({ host: 'admin.localhost', cookie: 'crme_psession=x', 'x-csrf-token': 't', 'content-length': '2' });
  });

  it('beberapa Set-Cookie dari API diteruskan utuh', () => {
    const h = downstreamHeaders({ 'set-cookie': ['crme_psession=a; HttpOnly', 'crme_pcsrf=b'], 'content-type': 'application/json', server: 'x' });
    expect(h.getSetCookie()).toEqual(['crme_psession=a; HttpOnly', 'crme_pcsrf=b']);
    expect(h.get('server')).toBeNull();
  });
});
