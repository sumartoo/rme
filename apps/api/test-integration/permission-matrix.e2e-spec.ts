import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { parse } from 'yaml';
import { createApp } from '../src/app/create-app';
import { PASSWORD, REPO, resetDatabase } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Matriks permission (AC-IAM-FR-011-1, gate Stage 6): SETIAP operasi klinik di kontrak yang memiliki `x-permission`
 * dipanggil langsung (tanpa UI/menu) oleh user yang tidak memiliki permission itu → harus 403 IAM-403-FORBIDDEN,
 * sebelum validasi body/parameter apa pun. Operasi yang belum diimplementasikan (404 dari router) dihitung terpisah —
 * begitu diimplementasikan, otomatis ikut diuji. User uji: role custom GUDANG (hanya pharmacy.stock.read, tanpa MFA).
 */
const HOST = 'klinik-a.clinicrme.test';
const USER_PERMS = new Set(['pharmacy.stock.read']);
const spec = parse(readFileSync(join(REPO, 'api', 'openapi.yaml'), 'utf8'), { maxAliasCount: -1 }) as {
  paths: Record<string, Record<string, { operationId: string; 'x-permission'?: string }>>;
};
const ops = Object.entries(spec.paths).flatMap(([path, o]) => Object.entries(o)
  .filter(([m, op]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m) && op['x-permission'] && path.startsWith('/api/v1/'))
  .map(([method, op]) => ({ method, path, id: op.operationId, permission: op['x-permission']! })))
  .filter((o) => !USER_PERMS.has(o.permission));
const concrete = (p: string) => p.replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000000');

let app: INestApplication;
let http: ReturnType<typeof request>;
let cookie = '', csrf = '';
beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  const r = await http.post('/api/v1/auth/login').set('Host', HOST).send({ email: 'gudang@a.test', password: PASSWORD });
  const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]);
  cookie = set.join('; ');
  csrf = set.find((c) => c.startsWith('crme_csrf='))!.split('=')[1];
});
afterAll(async () => { await app?.close(); });

test(`X01 semua operasi berpermission yang sudah diimplementasikan menolak user tanpa permission (${ops.length} operasi di kontrak)`, async () => {
  const results: { op: string; status: number; code?: string }[] = [];
  for (const o of ops) {
    const req = (http as unknown as Record<string, (p: string) => request.Test>)[o.method](concrete(o.path))
      .set('Host', HOST).set('Cookie', cookie).set('X-CSRF-Token', csrf);
    const r = ['post', 'put', 'patch'].includes(o.method) ? await req.send({}) : await req;
    results.push({ op: `${o.method.toUpperCase()} ${o.path} (${o.permission})`, status: r.status, code: r.body?.code });
  }
  const implemented = results.filter((r) => !(r.status === 404 && r.code === 'GEN-404'));
  const wrong = implemented.filter((r) => r.status !== 403 || r.code !== 'IAM-403-FORBIDDEN');
  console.log(`matriks permission: ${implemented.length} operasi terimplementasi diuji, ${results.length - implemented.length} belum diimplementasikan`);
  expect(wrong).toEqual([]);
  expect(implemented.length).toBeGreaterThanOrEqual(15);   // Stage 6 batch 1: 19; naik seiring modul diimplementasikan
});
