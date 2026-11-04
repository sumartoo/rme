import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { PLATFORM_ROLE_PERMISSIONS, platformPermissions } from './permissions';

describe('permission role platform', () => {
  it('sama dengan db/seed/role_templates.yaml (dokumen PERMISSION_MATRIX)', () => {
    const tpl = parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'db', 'seed', 'role_templates.yaml'), 'utf8')) as {
      platform_roles: Record<string, { permissions: string[] }>;
    };
    const fromYaml = Object.fromEntries(Object.entries(tpl.platform_roles).map(([k, v]) => [k, [...v.permissions].sort()]));
    const fromCode = Object.fromEntries(Object.entries(PLATFORM_ROLE_PERMISSIONS).map(([k, v]) => [k, [...(v as readonly string[])].sort()]));
    expect(fromCode).toEqual(fromYaml);
  });

  it('support tidak dapat mengelola tenant; role tak dikenal tidak memberi apa pun', () => {
    expect(platformPermissions(['PLATFORM_SUPPORT']).has('platform.tenant.manage')).toBe(false);
    expect(platformPermissions(['LAINNYA']).size).toBe(0);
  });
});
