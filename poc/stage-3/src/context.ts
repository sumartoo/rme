import { AsyncLocalStorage } from 'node:async_hooks';

/** Konteks per request (SC-TEN-01): diisi middleware & guard dari data server, tidak pernah dari body/query. */
export interface RequestContext {
  requestId: string;
  hostTenantId?: string;     // dari subdomain
  tenantId?: string;         // dari sesi terverifikasi (harus = hostTenantId)
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
