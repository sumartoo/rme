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
export interface Branch { id: string; code: string; name: string }
export interface Me {
  user: { id: string; email: string; fullName: string }; tenantId: string; permissions: string[]; mfaVerified: boolean;
  branches: Branch[]; activeBranchId: string | null;
}
export interface MenuNode { code: string; label: string; route?: string; icon?: string; children: MenuNode[] }
export interface UserItem { id: string; email: string; fullName: string; status: 'ACTIVE' | 'DISABLED'; lastLoginAt: string | null; roles: string[]; mfaEnrolled: boolean }
export interface Page<T> { data: T[]; page: { hasMore: boolean; nextCursor: string | null } }
export interface InvitationItem { id: string; email: string; expiresAt: string; createdAt?: string; acceptedAt: string | null; roles?: string[]; clinicName?: string }
export interface Role {
  id: string; code: string; name: string; isTemplate: boolean; requiresMfa: boolean; mfaLocked: boolean;
  permissions: string[]; userCount: number; version: number;
}
export interface Permission { code: string; module: string; description: string }
export interface SessionItem { id: string; userAgent: string | null; ip: string | null; createdAt: string; lastSeenAt: string; current: boolean }
export interface TenantProfile {
  displayName: string; letterhead: { name?: string; address?: string; phone?: string; license?: string } | null;
  logoFileId: string | null; settings: { pharmacyBeforeCashier?: boolean; discountLimitPercent?: number; noShowMinutes?: number }; version: number;
}
export type ExportStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'EXPIRED';
export interface ExportJob {
  id: string; status: ExportStatus; requestedAt: string; finishedAt: string | null; expiresAt: string | null;
  sizeBytes: number | null; sha256: string | null; tableCount: number | null; rowCount: number | null; error: string | null; downloadUrl: string | null;
}

// ------------------------------------------------------------------ Master data (Stage 7)
export type FacilityType = 'KLINIK_UTAMA' | 'KLINIK_PRATAMA' | 'PRAKTIK_MANDIRI';
export interface Facility { id: string; name: string; facilityType: FacilityType; licenseNumber: string | null; isActive: boolean; version: number }
export type Timezone = 'Asia/Jakarta' | 'Asia/Makassar' | 'Asia/Jayapura';
export interface BranchItem {
  id: string; facilityId: string; code: string; name: string; address: string | null; regionCode: string | null; phone: string | null;
  timezone: Timezone; isActive: boolean; version: number;
}
export type UnitType = 'POLI' | 'RUANG' | 'FARMASI' | 'KASIR' | 'LAB' | 'LAINNYA';
export interface ServiceUnit { id: string; branchId: string; code: string; name: string; unitType: UnitType; specialty: string | null; isActive: boolean; version: number }
export type PractitionerType = 'DOKTER' | 'DOKTER_GIGI' | 'DOKTER_SPESIALIS' | 'PERAWAT' | 'BIDAN' | 'APOTEKER' | 'TTK' | 'ANALIS' | 'LAINNYA';
export interface Practitioner {
  id: string; fullName: string; nikMasked: string | null; practitionerType: PractitionerType; specialty: string | null;
  strNumber: string | null; strValidUntil: string | null; sipNumber: string | null; sipValidUntil: string | null;
  satusehatIhsId: string | null; isActive: boolean; linkedUserId: string | null; version: number;
}
export type ServiceType = 'KONSULTASI' | 'TINDAKAN' | 'PAKET' | 'ADMINISTRASI' | 'LAB' | 'LAINNYA';
export type PayerType = 'UMUM' | 'ASURANSI' | 'PERUSAHAAN' | 'BPJS';
export interface ServiceItem { id: string; code: string; name: string; serviceType: ServiceType; icd9cmCode: string | null; isActive: boolean; version: number }
export interface Tariff { id: string; serviceItemId: string; branchId: string | null; payerType: PayerType | null; payerId: string | null; price: string; validFrom: string; validTo: string | null }
export interface PayerContract { contractNumber?: string; validUntil?: string; plafon?: string; copayPercent?: number; paymentTermDays?: number; notes?: string }
export interface Payer { id: string; code: string; name: string; payerType: PayerType; contract: PayerContract | null; isActive: boolean; version: number }
export interface Uom { id: string; code: string; name: string; isActive: boolean; version: number; conversions: { toUomId: string; factor: string }[] }
export interface Supplier {
  id: string; code: string | null; name: string; contactPerson: string | null; phone: string | null; email: string | null;
  address: string | null; npwp: string | null; isActive: boolean; version: number;
}
export type CodeSystemCode = 'ICD10' | 'ICD9CM';
export interface Concept {
  id: string; system: CodeSystemCode; code: string; display: string; displayEn: string | null; synonyms: string[]; isFavorite: boolean;
  favorite: { specialty: string | null; validated: boolean; validatedAt: string | null; validatedBy: string | null } | null;
}
export interface CodeSystem { code: string; version: string; source: string; effectiveDate: string | null; isCurrent: boolean; conceptCount: number; isSample: boolean }
export interface Region { code: string; name: string; level: number }
