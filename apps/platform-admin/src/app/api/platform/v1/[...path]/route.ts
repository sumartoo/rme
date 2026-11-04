import http from 'node:http';
import https from 'node:https';
import type { NextRequest } from 'next/server';
import { MAX_BODY_BYTES, downstreamHeaders, upstreamHeaders, upstreamPath } from '../../../../../lib/upstream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API = new URL(process.env.API_INTERNAL_URL ?? 'http://localhost:3000');
const PLATFORM_HOST = `admin.${process.env.BASE_DOMAIN ?? 'localhost'}`;
const problem = (status: number, code: string, title: string) =>
  Response.json({ type: 'about:blank', status, code, title }, { status, headers: { 'content-type': 'application/problem+json' } });

/** Meneruskan ke API dengan node:http (fetch tidak boleh mengganti header Host). */
async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const target = upstreamPath((await ctx.params).path, req.nextUrl.search);
  if (!target) return problem(404, 'GEN-404', 'Tidak ditemukan');
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.from(await req.arrayBuffer());
  if (body && body.length > MAX_BODY_BYTES) return problem(413, 'GEN-413', 'Body terlalu besar');

  return new Promise<Response>((resolve) => {
    const r = (API.protocol === 'https:' ? https : http).request({
      hostname: API.hostname, port: API.port, method: req.method, path: target, timeout: 30_000,
      headers: upstreamHeaders(req.headers, PLATFORM_HOST, body?.length),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 502;
        resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: downstreamHeaders(res.headers) }));
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', () => resolve(problem(502, 'GEN-502', 'Layanan API tidak dapat dihubungi')));
    if (body) r.write(body);
    r.end();
  });
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
