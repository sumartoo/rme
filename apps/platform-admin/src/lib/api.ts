'use client';

/** Error problem+json dari API (RFC 9457): `code` stabil, `title` aman ditampilkan. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, title: string) { super(title); }
}

function csrfToken(): string {
  return document.cookie.split('; ').find((c) => c.startsWith('crme_pcsrf='))?.slice('crme_pcsrf='.length) ?? '';
}

/** Semua panggilan lewat origin konsol (/api/platform/v1 → API). Cookie HttpOnly dikirim browser; CSRF via header. */
export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken();
  const res = await fetch(`/api/platform/v1${path}`, {
    method, headers, credentials: 'same-origin', cache: 'no-store',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) {
    const p = (await res.json().catch(() => ({}))) as { code?: string; title?: string };
    throw new ApiError(res.status, p.code ?? `GEN-${res.status}`, p.title ?? 'Permintaan gagal');
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export interface Me { id: string; email: string; fullName: string; roles: string[]; permissions: string[]; mfaVerified: boolean; mfaEnrolled: boolean }
export interface Plan { id: string; code: string; name: string; maxUsers: number; maxBranches: number }
export interface Tenant {
  id: string; code: string; legalName: string; displayName: string; tenantType: string; status: TenantStatus;
  plan?: { id: string; code: string; maxUsers: number; maxBranches: number }; trialEndsAt: string | null; createdAt: string;
  featureFlags?: Record<string, boolean>; allowedTransitions?: TenantStatus[];
}
export type TenantStatus = 'PROVISIONING' | 'TRIAL' | 'ACTIVE' | 'GRACE' | 'SUSPENDED' | 'TERMINATED';

/** Break-glass akses dukungan (PLT-FR-009, OD-076/077). */
export interface SupportGrant {
  id: string; tenantId: string; tenantCode: string; platformUserId: string; supportName: string; reason: string;
  startsAt: string; expiresAt: string; revokedAt: string | null; active: boolean;
}
export interface SupportUser { id: string; email: string; fullName: string; status: string; lastLoginAt: string | null; roles: string[] }
export interface SupportAuditEntry {
  seq: number; occurredAt: string; actorKind: string; actorUserId: string | null; action: string; resourceType: string; resourceId: string | null;
}
export interface Page<T> { data: T[]; page: { hasMore: boolean; nextCursor: string | null } }
