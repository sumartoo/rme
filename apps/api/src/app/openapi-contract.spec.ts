import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { parse } from 'yaml';
import {
  AUTHENTICATED_KEY, BODY_SCHEMA_KEY, INFRA_KEY, NO_BODY_KEY, PERMISSION_KEY, PLATFORM_KEY, PUBLIC_KEY, loadConfig,
} from '@clinicrme/shared';
import { createApp } from './create-app';

/**
 * Uji kontrak (ADR-0008): setiap endpoint yang SUDAH diimplementasikan harus cocok dengan kontrak
 * design-first api/openapi.yaml yang disetujui di Stage 2 — path, method, deklarasi akses (x-permission /
 * security: []), kode status sukses, dan ada/tidaknya request body. Endpoint @Infra (health) di luar kontrak.
 * Kontrak menang: bila berbeda, implementasi yang diperbaiki, atau kontrak diubah lewat CR.
 */
interface Route { key: string; method: string; path: string; access: { public: boolean; permission?: string; authenticated: boolean; platform: boolean };
  status: number; body: 'schema' | 'none' | 'undeclared' }

// File repo sendiri (dibangkitkan tools/gen_openapi.py, banyak alias YAML) — batas alias dinonaktifkan
const spec = parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'api', 'openapi.yaml'), 'utf8'), { maxAliasCount: -1 }) as {
  paths: Record<string, Record<string, { operationId: string; 'x-permission'?: string; security?: unknown[];
    requestBody?: { required?: boolean }; responses: Record<string, unknown> }>>;
};
const norm = (p: string) => p.replace(/\{[^}]+\}/g, '{}');
const contract = new Map<string, { path: string; op: (typeof spec.paths)[string][string] }>();
for (const [path, ops] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(ops)) contract.set(`${method.toUpperCase()} ${norm(path)}`, { path, op });
}

/** @PlatformPublic/@PlatformAuthenticated/@PlatformPermission → bentuk akses yang sama dengan route klinik. */
function platformAccess(v: string | undefined): Route['access'] | undefined {
  if (v === undefined) return undefined;
  return { public: v === 'public', authenticated: v === 'authenticated', permission: v.startsWith('platform.') ? v : undefined, platform: true };
}

let app: INestApplication;
let routes: Route[];

beforeAll(async () => {
  // Database tidak disentuh: pool baru terhubung saat query pertama.
  app = await createApp(loadConfig({
    APP_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: 'postgres://tidak-dipakai@127.0.0.1:1/x', PLATFORM_DATABASE_URL: 'postgres://tidak-dipakai@127.0.0.1:1/x',
    ENCRYPTION_KEY_HEX: 'a'.repeat(64), GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_REDIRECT_URI: 'https://x.invalid/cb',
  }));
  const discovery = app.get(DiscoveryService), scanner = app.get(MetadataScanner), reflector = app.get(Reflector);
  routes = [];
  for (const w of discovery.getControllers()) {
    const proto = w.metatype?.prototype;
    if (!proto) continue;
    const base = String(Reflect.getMetadata(PATH_METADATA, w.metatype as object) ?? '');
    for (const name of scanner.getAllMethodNames(proto)) {
      const h = proto[name];
      const m = Reflect.getMetadata(METHOD_METADATA, h) as RequestMethod | undefined;
      if (m === undefined) continue;
      const targets = [h, w.metatype as object] as never;
      if (reflector.getAllAndOverride(INFRA_KEY, targets)) continue;
      const sub = String(Reflect.getMetadata(PATH_METADATA, h) ?? '');
      const path = ('/' + [base, sub].filter((x) => x && x !== '/').join('/')).replace(/\/+/g, '/').replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const method = RequestMethod[m];
      routes.push({
        key: `${w.name}.${name}`, method, path,
        access: platformAccess(reflector.getAllAndOverride<string>(PLATFORM_KEY, targets)) ?? {
          public: !!reflector.getAllAndOverride(PUBLIC_KEY, targets),
          permission: reflector.getAllAndOverride<string>(PERMISSION_KEY, targets),
          authenticated: !!reflector.getAllAndOverride(AUTHENTICATED_KEY, targets),
          platform: false,
        },
        status: Reflect.getMetadata(HTTP_CODE_METADATA, h) ?? (method === 'POST' ? 201 : 200),
        body: reflector.getAllAndOverride(BODY_SCHEMA_KEY, targets) ? 'schema'
          : reflector.getAllAndOverride(NO_BODY_KEY, targets) ? 'none' : 'undeclared',
      });
    }
  }
});
afterAll(async () => { await app?.close(); });

describe('Kontrak OpenAPI (ADR-0008)', () => {
  it('ada endpoint yang diperiksa', () => expect(routes.length).toBeGreaterThanOrEqual(10));

  it('setiap endpoint terdaftar di api/openapi.yaml dengan path & method yang sama', () => {
    const missing = routes.filter((r) => !contract.has(`${r.method} ${norm(r.path)}`)).map((r) => `${r.method} ${r.path} (${r.key})`);
    expect(missing).toEqual([]);
  });

  it('deklarasi akses sama dengan kontrak: @Public ↔ security: [], @RequirePermission ↔ x-permission', () => {
    const diff: string[] = [];
    for (const r of routes) {
      const c = contract.get(`${r.method} ${norm(r.path)}`);
      if (!c) continue;
      const isPublic = Array.isArray(c.op.security) && c.op.security.length === 0;
      if (isPublic !== r.access.public) diff.push(`${r.key}: public impl=${r.access.public} kontrak=${isPublic}`);
      if ((c.op['x-permission'] ?? undefined) !== r.access.permission) {
        diff.push(`${r.key}: permission impl=${r.access.permission ?? '-'} kontrak=${c.op['x-permission'] ?? '-'}`);
      }
    }
    expect(diff).toEqual([]);
  });

  it('route konsol platform memakai skema keamanan platformSession (cookie crme_psession), route klinik tidak (CR-0001)', () => {
    const diff: string[] = [];
    for (const r of routes) {
      const c = contract.get(`${r.method} ${norm(r.path)}`);
      if (!c) continue;
      const usesPlatform = JSON.stringify(c.op.security ?? []).includes('platformSession');
      if (r.access.platform !== r.path.startsWith('/api/platform/')) diff.push(`${r.key}: deklarasi @Platform* tidak sesuai prefix path`);
      if (!r.access.public && r.access.platform !== usesPlatform) diff.push(`${r.key}: platform impl=${r.access.platform} kontrak=${usesPlatform}`);
    }
    expect(diff).toEqual([]);
  });

  it('kode status sukses sama dengan kontrak (redirect 302 ditangani handler)', () => {
    const diff: string[] = [];
    for (const r of routes) {
      const c = contract.get(`${r.method} ${norm(r.path)}`);
      if (!c) continue;
      const ok = Object.keys(c.op.responses).filter((s) => /^[23]\d\d$/.test(s));
      if (ok.includes('302')) continue;
      if (!ok.includes(String(r.status))) diff.push(`${r.key}: impl=${r.status} kontrak=${ok.join('/')}`);
    }
    expect(diff).toEqual([]);
  });

  it('request body: @BodySchema ↔ requestBody di kontrak; @NoBody ↔ tanpa requestBody wajib', () => {
    const diff: string[] = [];
    for (const r of routes) {
      const c = contract.get(`${r.method} ${norm(r.path)}`);
      if (!c || r.body === 'undeclared') continue;
      if (r.body === 'schema' && !c.op.requestBody) diff.push(`${r.key}: impl punya body, kontrak tidak`);
      if (r.body === 'none' && c.op.requestBody?.required) diff.push(`${r.key}: kontrak mewajibkan body, impl @NoBody`);
    }
    expect(diff).toEqual([]);
  });
});
