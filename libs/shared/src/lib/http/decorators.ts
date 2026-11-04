import { SetMetadata, applyDecorators } from '@nestjs/common';
import type { ZodType } from 'zod';

export const PUBLIC_KEY = 'crme:public';
export const INFRA_KEY = 'crme:infra';
export const PERMISSION_KEY = 'crme:permission';
export const AUTHENTICATED_KEY = 'crme:authenticated';
export const ALLOW_WITHOUT_MFA_KEY = 'crme:allowWithoutMfa';
export const BODY_SCHEMA_KEY = 'crme:bodySchema';
export const NO_BODY_KEY = 'crme:noBody';
/** Endpoint konsol platform (CR-0001). Nilai: 'public' | 'authenticated' | kode permission platform. */
export const PLATFORM_KEY = 'crme:platform';

/** Tanpa sesi (login, callback OAuth). Tenant tetap wajib dari subdomain. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Endpoint infrastruktur (health/readiness): tanpa tenant & tanpa sesi. Tidak boleh mengakses data tenant. */
export const Infra = () => SetMetadata(INFRA_KEY, true);
/** Butuh sesi dan permission tertentu (SC-AUTHZ-01). */
export const RequirePermission = (code: string) => SetMetadata(PERMISSION_KEY, code);
/** Butuh sesi saja (mis. /me, logout). */
export const Authenticated = () => SetMetadata(AUTHENTICATED_KEY, true);
/** Boleh diakses sebelum MFA diverifikasi (verifikasi MFA, logout). */
export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA_KEY, true);

/**
 * Skema Zod untuk body request (SC-WEB-05). Diterapkan oleh BodyValidationInterceptor global;
 * setiap handler POST/PUT/PATCH/DELETE wajib memakai @BodySchema atau @NoBody (dicek saat start).
 */
export const BodySchema = (schema: ZodType) => applyDecorators(SetMetadata(BODY_SCHEMA_KEY, schema));
/** Handler yang mengubah state tetapi tidak menerima body; body yang dikirim ditolak. */
export const NoBody = () => SetMetadata(NO_BODY_KEY, true);

/**
 * Endpoint konsol platform — hanya dilayani di host admin.<BASE_DOMAIN> dan dijaga PlatformSecurityGuard.
 * Guard tenant tidak pernah meloloskan route ini di host klinik (dan sebaliknya).
 */
export const PlatformPublic = () => SetMetadata(PLATFORM_KEY, 'public');
export const PlatformAuthenticated = () => SetMetadata(PLATFORM_KEY, 'authenticated');
export const PlatformPermission = (code: `platform.${string}`) => SetMetadata(PLATFORM_KEY, code);
