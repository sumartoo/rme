import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import {
  AUTHENTICATED_KEY, BODY_SCHEMA_KEY, INFRA_KEY, NO_BODY_KEY, PERMISSION_KEY, PLATFORM_KEY, PUBLIC_KEY,
} from './decorators';

const MUTATING = new Set([RequestMethod.POST, RequestMethod.PUT, RequestMethod.PATCH, RequestMethod.DELETE]);

/**
 * Pemeriksaan saat start — aplikasi menolak berjalan bila ada handler yang:
 * 1. tidak mendeklarasikan akses (@Public/@Infra/@Authenticated/@RequirePermission/@Platform*) — SC-AUTHZ-01, AC-IAM-FR-011-2;
 * 2. mengubah state tanpa @BodySchema atau @NoBody — SC-WEB-05;
 * 3. mencampur deklarasi platform (@Platform*) dengan deklarasi tenant.
 * Membutuhkan DiscoveryModule di modul root.
 */
export function assertRouteDeclarations(app: INestApplication) {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const reflector = app.get(Reflector);
  const noAccess: string[] = [];
  const noBody: string[] = [];
  const mixed: string[] = [];
  for (const w of discovery.getControllers()) {
    const proto = w.metatype?.prototype;
    if (!proto) continue;
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = proto[name];
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue; // bukan route handler
      const targets = [handler, w.metatype as object];
      const has = (k: string) => reflector.getAllAndOverride(k, targets as never) !== undefined;
      if (![PUBLIC_KEY, INFRA_KEY, AUTHENTICATED_KEY, PERMISSION_KEY, PLATFORM_KEY].some(has)) noAccess.push(`${w.name}.${name}`);
      // Route platform tidak boleh sekaligus memakai deklarasi akses tenant (ambiguitas guard)
      if (has(PLATFORM_KEY) && [PUBLIC_KEY, INFRA_KEY, AUTHENTICATED_KEY, PERMISSION_KEY].some(has)) mixed.push(`${w.name}.${name}`);
      if (MUTATING.has(method) && !has(BODY_SCHEMA_KEY) && !has(NO_BODY_KEY)) noBody.push(`${w.name}.${name}`);
    }
  }
  const problems = [
    noAccess.length ? `endpoint tanpa deklarasi akses: ${noAccess.join(', ')}` : '',
    noBody.length ? `endpoint tulis tanpa @BodySchema/@NoBody: ${noBody.join(', ')}` : '',
    mixed.length ? `endpoint mencampur deklarasi platform & tenant: ${mixed.join(', ')}` : '',
  ].filter(Boolean);
  if (problems.length) throw new Error(`Startup check gagal — ${problems.join('; ')}`);
}
