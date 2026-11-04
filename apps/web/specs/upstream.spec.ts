import { downstreamHeaders, tenantHost, upstreamHeaders, upstreamPath } from '../src/lib/upstream';

describe('penerusan aplikasi klinik → API (ADR-0002)', () => {
  it('klinik dari subdomain yang sah; konsol platform, host asing & kode aneh ditolak', () => {
    expect(tenantHost('klinik-a.localhost:4200', 'localhost')).toBe('klinik-a.localhost');
    expect(tenantHost('Klinik-A.clinicrme.id', 'clinicrme.id')).toBe('klinik-a.clinicrme.id');
    expect(tenantHost('admin.localhost:4200', 'localhost')).toBeNull();
    expect(tenantHost('localhost:4200', 'localhost')).toBeNull();
    expect(tenantHost('klinik-a.evil.test', 'localhost')).toBeNull();
    expect(tenantHost('a.b.localhost', 'localhost')).toBeNull();
    expect(tenantHost(null, 'localhost')).toBeNull();
  });

  it('hanya path /api/v1 dengan segmen aman; traversal ditolak', () => {
    expect(upstreamPath(['tenant', 'profile'], '')).toBe('/api/v1/tenant/profile');
    expect(upstreamPath(['..', 'platform', 'v1', 'tenants'], '')).toBeNull();
    expect(upstreamPath(['tenant%2F..'], '')).toBeNull();
  });

  it('Host hasil validasi menggantikan Host browser; If-Match diteruskan; header lain tidak', () => {
    const h = upstreamHeaders(new Headers({ host: 'evil.test', cookie: 'crme_session=x', 'if-match': '"3"', authorization: 'Bearer y' }), 'klinik-a.localhost');
    expect(h).toEqual({ host: 'klinik-a.localhost', cookie: 'crme_session=x', 'if-match': '"3"' });
  });

  it('header unduhan & redirect diteruskan, header server tidak', () => {
    const h = downstreamHeaders({ 'content-disposition': 'attachment; filename="x.crmex"', location: '/', etag: '"4"', server: 'x' });
    expect(h.get('content-disposition')).toContain('x.crmex');
    expect(h.get('location')).toBe('/');
    expect(h.get('etag')).toBe('"4"');
    expect(h.get('server')).toBeNull();
  });
});
