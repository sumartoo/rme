import { buildCsp } from '../src/lib/csp';

describe('CSP (SC-WEB-01)', () => {
  it('produksi: nonce, tanpa unsafe-eval/unsafe-inline, frame-ancestors none', () => {
    const csp = buildCsp('abc123', false);
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('unsafe-inline');
  });

  it('development: unsafe-eval hanya di dev', () => {
    expect(buildCsp('n', true)).toContain("'unsafe-eval'");
  });
});
