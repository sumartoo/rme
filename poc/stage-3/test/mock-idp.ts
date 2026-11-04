import { createServer, Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, JWK } from 'jose';
import { AddressInfo } from 'node:net';

/**
 * IdP OIDC tiruan untuk uji: discovery, JWKS, dan token endpoint.
 * Uji mendaftarkan klaim untuk sebuah `code`, lalu token endpoint mengembalikan id_token bertanda tangan RS256.
 * Memverifikasi PKCE (S256) seperti Google.
 */
export class MockIdp {
  private server!: Server;
  private key!: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  private jwk!: JWK;
  issuer = '';
  private codes = new Map<string, { claims: Record<string, unknown>; challenge?: string; signWithForeignKey?: boolean }>();
  lastTokenRequest?: URLSearchParams;

  async start() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    this.key = privateKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url!, this.issuer);
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(res, { issuer: this.issuer, authorization_endpoint: `${this.issuer}/authorize`,
                           token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/jwks` });
      }
      if (url.pathname === '/jwks') return json(res, { keys: [this.jwk] });
      if (url.pathname === '/token' && req.method === 'POST') {
        const body = new URLSearchParams(await readBody(req));
        this.lastTokenRequest = body;
        const entry = this.codes.get(body.get('code') ?? '');
        if (!entry) return json(res, { error: 'invalid_grant' }, 400);
        const { createHash } = await import('node:crypto');
        if (entry.challenge && createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== entry.challenge) {
          return json(res, { error: 'invalid_grant', error_description: 'PKCE' }, 400);
        }
        const signer = new SignJWT(entry.claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt().setExpirationTime('5m');
        const key = entry.signWithForeignKey ? (await generateKeyPair('RS256')).privateKey : this.key;
        return json(res, { id_token: await signer.sign(key), access_token: 'x', token_type: 'Bearer' });
      }
      json(res, { error: 'not_found' }, 404);
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Daftarkan code → klaim. Default klaim valid; override per uji. */
  issue(code: string, claims: Record<string, unknown>, opts: { challenge?: string; signWithForeignKey?: boolean } = {}) {
    this.codes.set(code, { claims, ...opts });
  }

  stop() { return new Promise((r) => this.server.close(r)); }
}

function json(res: any, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req: any): Promise<string> {
  return new Promise((r) => { let d = ''; req.on('data', (c: Buffer) => (d += c)); req.on('end', () => r(d)); });
}
