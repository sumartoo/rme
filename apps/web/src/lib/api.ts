'use client';

/** Error problem+json dari API (RFC 9457): `code` stabil, `title` aman ditampilkan. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, title: string) { super(title); }
}

function csrfToken(): string {
  return document.cookie.split('; ').find((c) => c.startsWith('crme_csrf='))?.slice('crme_csrf='.length) ?? '';
}

/**
 * Semua panggilan lewat origin klinik (/api/v1 → API, klinik dari subdomain). Cookie sesi HttpOnly dikirim browser;
 * CSRF double-submit lewat header untuk metode yang mengubah data.
 */
export async function apiRaw(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken();
  const res = await fetch(`/api/v1${path}`, {
    method, headers, credentials: 'same-origin', cache: 'no-store',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) {
    const p = (await res.json().catch(() => ({}))) as { code?: string; title?: string };
    throw new ApiError(res.status, p.code ?? `GEN-${res.status}`, p.title ?? 'Permintaan gagal');
  }
  return res;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await apiRaw(path, opts);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export interface AuthSession {
  email: string; fullName: string; tenant: { code: string; name: string };
  mfaRequired: boolean; mfaEnrolled: boolean; mfaVerified: boolean;
}
export interface Me { user: { id: string; email: string; fullName: string }; tenantId: string; permissions: string[]; mfaVerified: boolean }
export interface TenantProfile {
  displayName: string; letterhead: { name?: string; address?: string; phone?: string; license?: string } | null;
  logoFileId: string | null; settings: { pharmacyBeforeCashier?: boolean; discountLimitPercent?: number; noShowMinutes?: number }; version: number;
}
export type ExportStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'EXPIRED';
export interface ExportJob {
  id: string; status: ExportStatus; requestedAt: string; finishedAt: string | null; expiresAt: string | null;
  sizeBytes: number | null; sha256: string | null; tableCount: number | null; rowCount: number | null; error: string | null; downloadUrl: string | null;
}
