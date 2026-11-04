import { SetMetadata } from '@nestjs/common';

export const PUBLIC_KEY = 'crme:public';
export const PERMISSION_KEY = 'crme:permission';
export const AUTHENTICATED_KEY = 'crme:authenticated';
export const ALLOW_WITHOUT_MFA_KEY = 'crme:allowWithoutMfa';

/** Tanpa sesi (login, callback). Tenant tetap wajib dari subdomain. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Butuh sesi dan permission tertentu (SC-AUTHZ-01). */
export const RequirePermission = (code: string) => SetMetadata(PERMISSION_KEY, code);
/** Butuh sesi saja (mis. /me, logout). */
export const Authenticated = () => SetMetadata(AUTHENTICATED_KEY, true);
/** Boleh diakses sebelum MFA diverifikasi (verifikasi MFA, logout). */
export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA_KEY, true);
