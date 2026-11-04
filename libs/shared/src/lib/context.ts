import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Konteks per request (SC-TEN-01): diisi middleware & guard dari data server, tidak pernah dari body/query.
 * Objek yang sama juga ditempel ke request (`req.crme`) agar logger dapat membacanya saat respons selesai.
 */
export interface RequestContext {
  requestId: string;
  hostTenantId?: string;
  /** Status tenant dari subdomain (TRIAL/ACTIVE/GRACE/SUSPENDED) — dipakai guard untuk PLT-FR-006. */
  hostTenantStatus?: string;
  /** Request datang ke host konsol platform (admin.<BASE_DOMAIN>, CR-0001). */
  platformHost?: boolean;
  platformUserId?: string;
  platformSessionId?: string;
  platformRoles?: string[];
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  branchId?: string | null;
  mfaVerified?: boolean;
  mfaRequired?: boolean;
  permissions?: Set<string>;
  ip?: string;
  userAgent?: string;
}

export const als = new AsyncLocalStorage<RequestContext>();

export function ctx(): RequestContext {
  const c = als.getStore();
  if (!c) throw new Error('Request context tidak tersedia');
  return c;
}
