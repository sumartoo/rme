/** Role platform → permission (CR-0001). Sumber dokumentasi: db/seed/role_templates.yaml (platform_roles). */
export const PLATFORM_ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  PLATFORM_ADMIN: ['platform.tenant.manage', 'platform.tenant.read'],
  PLATFORM_SUPPORT: ['platform.support.access', 'platform.tenant.read'],
};

export function platformPermissions(roles: readonly string[]): Set<string> {
  return new Set(roles.flatMap((r) => PLATFORM_ROLE_PERMISSIONS[r] ?? []));
}
