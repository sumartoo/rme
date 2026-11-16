'use client';

/** Error problem+json dari API (RFC 9457): `code` stabil, `title` aman ditampilkan. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, title: string, readonly problem: Problem = {}) { super(title); }
}
/** Isi problem+json: `errors` per field (400) dan field tambahan seperti `candidates` (PAT-409-DUPLICATE). */
export interface Problem { errors?: { field: string; message: string }[]; candidates?: PatientSummary[] }

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
    const p = (await res.json().catch(() => ({}))) as { code?: string; title?: string } & Problem;
    throw new ApiError(res.status, p.code ?? `GEN-${res.status}`, p.title ?? 'Permintaan gagal', p);
  }
  return res;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await apiRaw(path, opts);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Unggah berkas mentah (impor master data): body = isi berkas, Content-Type sesuai jenis berkas. */
export async function apiUpload<T>(path: string, file: Blob, contentType: string): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', body: file,
    headers: { accept: 'application/json', 'content-type': contentType, 'x-csrf-token': csrfToken() },
  });
  if (!res.ok) {
    const p = (await res.json().catch(() => ({}))) as { code?: string; title?: string };
    throw new ApiError(res.status, p.code ?? `GEN-${res.status}`, p.title ?? 'Permintaan gagal');
  }
  return (await res.json()) as T;
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
export interface UserItem { id: string; email: string; fullName: string; status: 'ACTIVE' | 'DISABLED'; lastLoginAt: string | null; roles: string[]; mfaEnrolled: boolean; practitionerId?: string | null }
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
  logoFileId: string | null; settings: { pharmacyBeforeCashier?: boolean; dispenseMethod?: 'FEFO' | 'FIFO'; partialPickupDays?: number; discountLimitPercent?: number; noShowMinutes?: number; lateToleranceMinutes?: number; mrnPrefix?: string; queueDisplayInitials?: boolean }; version: number;
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
  timezone: Timezone; adminServiceId: string | null; isActive: boolean; version: number;
}
export type UnitType = 'POLI' | 'RUANG' | 'FARMASI' | 'KASIR' | 'LAB' | 'LAINNYA';
export interface ServiceUnit { id: string; branchId: string; code: string; name: string; unitType: UnitType; specialty: string | null; queuePrefix: string | null; defaultTemplate: TemplateCode | null; consultServiceId: string | null; isActive: boolean; version: number }
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
export interface ImportResult {
  entity: string; status: 'VALIDATED' | 'COMMITTED' | 'FAILED'; dryRun: boolean; rowCount: number; created: number; updated: number;
  errors: { row: number; field: string; message: string }[];
}

// ------------------------------------------------------------------ Pasien (Stage 8)
export type Sex = 'L' | 'P' | 'TIDAK_DIKETAHUI';
export type IdentityType = 'NIK' | 'PASPOR' | 'KITAS' | 'BAYI_IDENTITAS_IBU' | 'TANPA_IDENTITAS';
export interface PatientSummary {
  id: string; mrn: string; fullName: string; birthDate: string; sex: Sex; nikMasked: string | null; phone: string | null;
  status: 'ACTIVE' | 'MERGED' | 'DECEASED' | 'INACTIVE'; identityType: IdentityType; identityMasked: string | null; score?: number;
}
export interface PatientContact { id?: string; relation: string; fullName: string; phone: string; isGuardian: boolean }
export interface Coverage {
  id: string; payerId: string; payerName: string; payerType: PayerType; memberNo: string | null; planName: string | null; employeeNo: string | null;
  bpjsFaskesCode: string | null; validFrom: string | null; validTo: string | null; isActive: boolean; version: number;
}
export interface PatientConsent {
  id: string; consentType: string; version: string; title: string | null; granted: boolean; signedByName: string | null;
  signedByRelation: string | null; recordedAt: string; revokedAt: string | null;
}
export interface Patient extends PatientSummary {
  email: string | null; address: string | null; regionCode: string | null; ihsStatus: string; mother: PatientSummary | null;
  mergedInto: PatientSummary | null; mergedAt: string | null; mergeReason: string | null; processingRestricted: boolean;
  restrictionReason: string | null; restrictedAt: string | null; createdAt: string; contacts: PatientContact[]; coverages: Coverage[];
  consents: PatientConsent[]; hasConsent: boolean; hasActiveCoverage: boolean; version: number;
}
export interface ConsentDocument { id: string; consentType: 'UMUM' | 'DATA_SHARING' | 'PORTAL'; version: string; title: string | null; content: string; effectiveAt: string }

// ------------------------------------------------------------------ Jadwal & janji temu (Stage 8)
export interface Schedule {
  id: string; practitionerId: string; practitionerName: string; branchId: string; branchName: string; timezone: Timezone; unitId: string; unitName: string;
  dayOfWeek: number; startTime: string; endTime: string; slotMinutes: number; quota: number; slotCount: number; validFrom: string; validTo: string | null;
  isActive: boolean; version: number;
}
export interface ScheduleException {
  id: string; practitionerId: string | null; practitionerName: string | null; branchId: string | null; branchName: string | null;
  exceptionDate: string; reason: string; affectedAppointments?: Appointment[];
}
export interface Slot { start: string; end: string; available: boolean; taken: boolean }
export interface SlotSession extends Schedule { booked: number; closed: { reason: string; type: 'CUTI_DOKTER' | 'LIBUR_CABANG' } | null; slots: Slot[] }
export type AppointmentStatus = 'BOOKED' | 'CHECKED_IN' | 'CANCELLED' | 'NO_SHOW' | 'RESCHEDULED';
export interface Appointment {
  id: string; status: AppointmentStatus; statusReason: string | null; channel: string; notes: string | null; slotStart: string; slotEnd: string | null;
  localDate: string; localTime: string; timezone: Timezone; rescheduledToId: string | null; practitionerId: string; practitionerName: string;
  branchId: string; branchName: string; unitId: string; unitName: string;
  patient: { id: string; mrn: string; fullName: string; birthDate: string; sex: Sex; phone: string | null; status: string }; version: number;
}

// ------------------------------------------------------------------ Kunjungan & antrean (Stage 8)
export type EncounterStatus = 'REGISTERED' | 'ARRIVED' | 'TRIAGED' | 'IN_CONSULTATION' | 'CONSULT_DONE' | 'PHARMACY' | 'BILLING' | 'FINISHED' | 'CANCELLED';
export type TicketStatus = 'WAITING' | 'CALLED' | 'SKIPPED' | 'SERVED' | 'CANCELLED';
export interface Encounter {
  id: string; encounterNo: string; status: EncounterStatus; arrivalType: 'WALK_IN' | 'APPOINTMENT'; arrivedAt: string; arrivedLate: boolean;
  localDate: string; localTime: string; timezone: Timezone; cancelReason: string | null;
  patient: { id: string; mrn: string; fullName: string; birthDate: string; sex: Sex; phone: string | null };
  branchId: string; branchName: string; unitId: string; unitName: string; practitionerId: string; practitionerName: string;
  payerType: PayerType; coverage: { id: string; payerName: string; memberNo: string | null } | null; coverageVerificationNote: string | null;
  appointment: { id: string; slotStart: string | null } | null;
  queue: { id: string; displayCode: string; queueNumber: number; status: TicketStatus; calledAt: string | null; callCount: number } | null;
  warnings?: string[]; version: number;
}
export interface QueueTicket {
  id: string; displayCode: string; queueNumber: number; status: TicketStatus; calledAt: string | null; callCount: number; unitName: string;
  practitionerId: string | null; practitionerName: string | null; encounterId: string; encounterNo: string; arrivalType: string; arrivedLate: boolean;
  patient: { id: string; mrn: string; fullName: string };
}

// Stage 9 — rekam medis rawat jalan
export type TemplateCode = 'UMUM' | 'GIGI' | 'ANAK' | 'KEBIDANAN';
export interface TemplateField { key: string; label: string; type: 'text' | 'number' | 'date' | 'select'; section: 'S' | 'O' | 'A' | 'P';
  unit?: string; options?: string[]; min?: number; max?: number; maxLength?: number; hint?: string }
export interface ClinicalTemplate { code: TemplateCode; name: string; fields: TemplateField[] }
export interface WorklistItem {
  id: string; encounterNo: string; status: EncounterStatus; arrivedAt: string; localTime: string; triagedAt: string | null; consultStartedAt: string | null;
  unitId: string; unitName: string; practitionerId: string; practitionerName: string; payerType: PayerType;
  patient: { id: string; mrn: string; fullName: string; birthDate: string; sex: string; age: string };
  queue: { displayCode: string; status: string } | null; noteStatus: 'DRAFT' | 'SIGNED' | null; allergyCount: number;
}
export type ClinicalStatus = 'ACTIVE' | 'INACTIVE' | 'ENTERED_IN_ERROR';
export interface Allergy { id: string; substance: string; category: 'OBAT' | 'MAKANAN' | 'LINGKUNGAN' | 'LAINNYA'; reaction: string | null;
  severity: 'RINGAN' | 'SEDANG' | 'BERAT' | null; status: ClinicalStatus; statusReason: string | null; recordedAt: string; recordedByName: string | null }
export interface HistoryEntry { id: string; historyType: 'PENYAKIT' | 'OBAT_RUTIN' | 'KELUARGA' | 'SOSIAL' | 'OPERASI'; description: string;
  status: ClinicalStatus; statusReason: string | null; recordedAt: string; recordedByName: string | null }
export interface ClinicalNote { id: string; templateCode: TemplateCode; subjective: string | null; objective: string | null; assessment: string | null;
  plan: string | null; structured: Record<string, unknown>; status: 'DRAFT' | 'SIGNED'; signedAt: string | null; signedByName: string | null;
  signerSip: string | null; signMethod: 'PASSWORD' | 'TOTP' | null; substituteReason: string | null; contentHash: string | null;
  addenda: Addendum[]; updatedAt: string; updatedByName: string | null; version: number }
export interface Addendum { id: string; reason: string; content: string; authorId: string; authorName: string; authorSip: string | null;
  signMethod: 'PASSWORD' | 'TOTP' | null; signedAt: string; contentHash: string }
export interface MedicalRecordEntry { encounterId: string; encounterNo: string; localDate: string; unitName: string; practitionerName: string;
  status: EncounterStatus; note: ClinicalNote | null; diagnoses: Diagnosis[]; procedures: Procedure[]; vitals: VitalSet | null }
export interface VitalSet { recordedAt: string; recordedByName: string | null; values: Record<string, number> }
export interface Diagnosis { id: string; conceptId: string; code: string; display: string; rank: 'PRIMER' | 'SEKUNDER'; caseStatus: 'BARU' | 'LAMA'; note: string | null }
export interface Procedure { id: string; serviceItemId: string; serviceName: string; conceptId: string | null; code: string | null; display: string | null;
  performedBy: string; performedByName: string; qty: number; performedAt: string }
export interface EncounterChart {
  encounter: { id: string; encounterNo: string; status: EncounterStatus; arrivedAt: string; localDate: string; triagedAt: string | null;
    consultStartedAt: string | null; branchId: string; branchName: string; unitId: string; unitName: string; practitionerId: string;
    practitionerName: string; payerType: PayerType; payerName: string | null; version: number };
  patient: { id: string; mrn: string; fullName: string; birthDate: string; sex: string; age: string; processingRestricted: boolean;
    allergies: Allergy[]; history: HistoryEntry[] };
  templateCode: TemplateCode; note: ClinicalNote | null; vitals: VitalSet[]; diagnoses: Diagnosis[]; procedures: Procedure[]; prescription: Prescription | null;
  previousVisits: { id: string; encounterNo: string; localDate: string; unitName: string; practitionerName: string; status: EncounterStatus;
    noteStatus: string | null; primaryDiagnosis: { code: string; display: string } | null; assessment: string | null }[];
  editable: boolean;
}
export type DrugClass = 'BEBAS' | 'BEBAS_TERBATAS' | 'KERAS' | 'NARKOTIKA' | 'PSIKOTROPIKA' | 'PREKURSOR' | 'ALKES' | 'LAINNYA';
export interface Drug { id: string; code: string; genericName: string; brandName: string | null; dosageForm: string; strength: string | null;
  baseUomId: string; uomCode: string; uomName: string; drugClass: DrugClass; ingredients: string[]; maxDoseQty: string | null; maxDailyQty: string | null;
  kfaCode: string | null; minStock: string; isActive: boolean; version: number }
// Farmasi & persediaan (Stage 10)
export interface StockLocation { id: string; branchId: string; branchName: string; name: string; isDefault: boolean; isActive: boolean; version: number }
export interface DrugPrice { id: string; branchId: string | null; branchName: string | null; payerType: PayerType | null; hna: string | null; het: string | null;
  sellPrice: string; validFrom: string; validTo: string | null; createdAt: string }
export interface StockLevel { drugItemId: string; code: string; genericName: string; drugClass: DrugClass; uomName: string; minStock: number; onHand: number;
  usable: number; nearestExpiry: string | null; expiringQty: number; expiredQty: number; isActive: boolean; low: boolean }
export interface StockList extends Page<StockLevel> { expiryWarningDays: number }
export interface StockDetail { drugItemId: string; genericName: string; uomName: string;
  batches: { batchId: string; batchNo: string; expiryDate: string; unitCost: string; locationId: string; locationName: string; branchName: string; qtyOnHand: number }[];
  movements: { id: string; occurredAt: string; type: string; qty: number; batchNo: string; locationName: string; refType: string; refId: string; actorName: string | null }[] }
export type RxStatus = 'ISSUED' | 'VERIFIED' | 'PARTIALLY_DISPENSED' | 'DISPENSED' | 'CLOSED';
export interface PharmacyWorkItem { id: string; prescriptionNo: string; status: RxStatus; issuedAt: string; firstDispensedAt: string | null; reviewed: boolean;
  reviewProblem: boolean; alertCount: number; encounterNo: string; encounterStatus: string; payerType: PayerType; patient: { id: string; name: string; mrn: string };
  prescriberName: string; branchName: string; itemCount: number; pickupDeadline: string | null }
export interface RxStockPlan { drugItemId: string; drugName: string; drugClass: DrugClass; restricted: boolean; need: number; unitPrice: string | null;
  available: number | null; allocation: { batchId: string; qty: number }[]; batches: { batchId: string; batchNo: string; expiryDate: string; qtyOnHand: number }[] }
export interface RxPharmacyItem { id: string; lineNo: number; kind: 'DRUG' | 'COMPOUND'; drugItemId: string | null; drugName: string | null; strength: string | null;
  dosageForm: string | null; compoundName: string | null; compoundForm: string | null; dose: string | null; frequency: string; route: string;
  durationDays: number | null; qty: number; uomName: string; instructions: string | null; qtyDispensed: number; qtyClosed: number; closeReason: string | null;
  remaining: number; components: { drugItemId: string; drugName: string; qty: number; uomName: string }[]; stock: RxStockPlan[];
  substitutedFromName: string | null; substitution: { id: string; status: Substitution['status']; toDrugName: string; reason: string; decisionNote: string | null;
    requestedAt: string; decidedByName: string | null } | null }
export interface DispenseLine { id: string; prescriptionItemId: string; drugItemId: string; drugName: string; batchNo: string; expiryDate: string; qtyBase: number;
  uomName: string; unitPrice: string; amount: string; batchReason: string | null; billingStatus: 'UNBILLED' | 'BILLED' | 'VOID' }
export interface ChecklistDef { key: string; group: 'ADMINISTRATIF' | 'FARMASETIK' | 'KLINIS'; label: string }
export interface PharmacyPrescription { id: string; prescriptionNo: string; status: RxStatus; version: number; issuedAt: string; firstDispensedAt: string | null;
  pickupDeadline: string | null; closedReason: string | null; notes: string | null; alerts: { key: string; type: string; message: string; reason?: string | null }[];
  dispenseMethod: 'FEFO' | 'FIFO'; encounter: { id: string; encounterNo: string; status: string; payerType: PayerType; branchId: string; branchName: string };
  patient: { id: string; name: string; mrn: string; birthDate: string; sex: string; allergies: { substance: string; reaction: string | null; severity: string | null }[] };
  prescriber: { name: string; sipNumber: string | null };
  review: { items: Record<string, { ok: boolean; note: string | null }>; result: 'OK' | 'PROBLEM'; reviewedAt: string; reviewerName: string | null } | null;
  checklist: ChecklistDef[]; location: { id: string; name: string } | null; items: RxPharmacyItem[];
  dispenses: { id: string; dispensedAt: string; dispensedByName: string; locationName: string; handedTo: string | null; lines: DispenseLine[] }[];
  medicationHistory: { dispensedAt: string; prescriptionNo: string; drugName: string; qty: number; uomName: string }[] }
export interface Substitution { id: string; status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; reason: string; requestedAt: string; requestedByName: string;
  decidedAt: string | null; decidedByName: string | null; decisionNote: string | null;
  prescription: { id: string; prescriptionNo: string; encounterNo: string; branchName: string; prescriberName: string };
  patient: { id: string; name: string; mrn: string }; item: { id: string; lineNo: number; qty: number; uomName: string; frequency: string };
  fromDrug: { id: string; name: string }; toDrug: { id: string; name: string; strength: string | null; drugClass: DrugClass }; allergyWarnings: string[] }
export interface StockAdjustment { id: string; status: 'REQUESTED' | 'APPROVED' | 'REJECTED'; qtyDelta: number; reason: string; createdAt: string;
  decidedAt: string | null; decisionNote: string | null; requestedByName: string; approvedByName: string | null; mine: boolean;
  batch: { id: string; batchNo: string; expiryDate: string }; drug: { id: string; name: string; drugClass: DrugClass; uomName: string };
  location: { id: string; name: string }; qtyOnHand: number }
export interface StockOpname { id: string; status: 'COUNTING' | 'SUBMITTED' | 'APPROVED' | 'CANCELLED'; version: number; location: { id: string; name: string; branchName: string };
  notes: string | null; startedByName: string; startedAt: string; submittedAt: string | null; submittedByName: string | null; approvedAt: string | null;
  approvedByName: string | null; decisionNote: string | null; mine: boolean; lineCount?: number; countedCount?: number; diffCount?: number;
  lines?: { batchId: string; batchNo: string; expiryDate: string; drugItemId: string; drugName: string; drugClass: DrugClass; restricted: boolean; uomName: string;
    systemQty: number; countedQty: number | null; difference: number | null; note: string | null; countedByName: string | null }[] }
export interface ControlledReport { columns: { key: string; label: string; type: string }[]; month: string; branchName: string | null; note: string;
  rows: { code: string; drugName: string; drugClass: DrugClass; uomName: string; opening: number; received: number; dispensed: number; otherOut: number;
    adjusted: number; closing: number }[] }
export interface OtcSale { id: string; saleNo: string; status: 'AWAITING_PAYMENT' | 'PAID' | 'CANCELLED'; branchName: string; locationName: string;
  customerName: string | null; patient: { name: string; mrn: string } | null; soldAt: string; soldByName: string; total: string; notes: string | null;
  cancelReason: string | null; cancelledAt: string | null;
  lines: { id: string; drugItemId: string; drugName: string; batchNo: string; expiryDate: string; qtyBase: number; uomName: string; unitPrice: string; amount: string }[] }
export interface StockReportRow { code: string; drugName: string; drugClass: DrugClass; uomName: string; opening: number; received: number; returnedIn: number;
  dispensed: number; otcSold: number; otherOut: number; adjusted: number; closing: number; closingValue: string }
export interface StockReport { rows: StockReportRow[]; from: string; to: string; totals: { closingValue: string } }
export interface DispenseResult { dispenseId: string; prescriptionStatus: RxStatus; encounterStatus: string; lines: DispenseLine[] }
export interface GoodsReceipt { id: string; receiptNo: string; supplierId: string; supplierName: string; locationId: string; locationName: string; branchName: string;
  invoiceNo: string; invoiceDate: string | null; notes: string | null; receivedAt: string; receivedByName: string | null; lineCount: number; total: string;
  lines?: { id: string; drugItemId: string; drugName: string; batchNo: string; expiryDate: string; qty: number; uomName: string; qtyBase: number;
    baseUomName: string; unitPrice: string }[] }
export type RxRoute = 'ORAL' | 'SUBLINGUAL' | 'TOPIKAL' | 'TETES_MATA' | 'TETES_TELINGA' | 'INHALASI' | 'REKTAL' | 'INJEKSI' | 'LAINNYA';
export interface RxAlert { key: string; type: 'ALLERGY' | 'DUPLICATE' | 'DOSE_MAX' | 'DAILY_MAX'; lineNo: number | null; message: string; reason: string | null }
export interface PrescriptionItem { id: string; lineNo: number; kind: 'DRUG' | 'COMPOUND'; drugItemId: string | null; drugName: string | null;
  strength: string | null; compoundName: string | null; compoundForm: string | null; doseQty: number | null; timesPerDay: number | null; frequency: string;
  route: RxRoute; durationDays: number | null; qty: number; uomId: string; uomName: string; instructions: string | null;
  components: { drugItemId: string; drugName: string; qty: number; uomName: string }[] }
export interface Prescription { id: string; prescriptionNo: string; status: string; issuedAt: string | null; prescriberName: string; notes: string | null;
  alerts: RxAlert[]; items: PrescriptionItem[]; version: number }


// Kasir & tagihan (Stage 11)
export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'VOID';
export interface BillingWorkItem { type: 'ENCOUNTER' | 'DRUG' | 'OTC'; refId: string; refNo: string; refStatus: string; at: string;
  patient: { name: string; mrn: string } | null; customerName: string | null; payerType: PayerType; payerName: string | null; unitName: string | null;
  invoice: { id: string; status: InvoiceStatus; invoiceNo: string | null; netAmount: string; patientPortion: string } | null }
export interface InvoiceLine { id: string; lineNo: number; sourceType: 'KONSULTASI' | 'TINDAKAN' | 'OBAT' | 'LAB' | 'ADMINISTRASI' | 'LAINNYA'; description: string;
  qty: number; unitPrice: string; discountAmount: string; lineTotal: string; payerPortion: string; patientPortion: string; isManual: boolean;
  serviceItemId: string | null; discountReason: string | null; discountStatus: 'NONE' | 'WITHIN_LIMIT' | 'PENDING' | 'APPROVED';
  discountRequestedByName: string | null; discountMine: boolean; discountApprovedByName: string | null; splitReason: string | null }
export interface Invoice { id: string; kind: 'ENCOUNTER' | 'DRUG' | 'OTC'; status: InvoiceStatus; invoiceNo: string | null; branchName: string; payerType: PayerType;
  payerName: string | null; contract: { copayPercent: number; plafon: string | number | null; validUntil: string | null } | null;
  patient: { id: string; name: string; mrn: string } | null; customerName: string | null; encounterId: string | null; encounterNo: string | null;
  otcSaleId: string | null; saleNo: string | null; grossAmount: string; discountAmount: string; netAmount: string; payerPortion: string; patientPortion: string;
  paidAmount: string; outstanding: string; payments: Payment[];
  receivable: { id: string; amount: string; paidAmount: string; dueDate: string; status: ReceivableStatus } | null; issuedAt: string | null;
  voids: InvoiceVoidEntry[]; refunds: Refund[]; replaces: { id: string; invoiceNo: string | null } | null;
  replacedBy: { id: string; invoiceNo: string | null; status: InvoiceStatus } | null; pendingQrisId: string | null; issuedByName: string | null; createdAt: string; version: number; warnings: string[]; lines: InvoiceLine[] }
export type PaymentMethod = 'TUNAI' | 'DEBIT' | 'KARTU_KREDIT' | 'TRANSFER' | 'QRIS';
export interface Payment { id: string; receiptNo: string; method: PaymentMethod; amount: string; cashTendered: string | null; change: string | null;
  reference: string | null; receivedAt: string; receivedByName: string; receiptUrl: string; invoiceStatus?: InvoiceStatus }
export interface CashierShift { id: string; status: 'OPEN' | 'CLOSED' | 'VERIFIED'; branchId: string; branchName: string; cashierName: string; openedAt: string;
  closedAt: string | null; openingCash: string; expectedCash: string; countedCash: string | null; variance: string | null; varianceNote: string | null;
  paymentCount: number; cashRefunds: string; totals: { method: PaymentMethod; count: number; total: string }[] }
export type ReceivableStatus = 'OPEN' | 'PARTIAL' | 'PAID' | 'WRITTEN_OFF';
export interface Receivable { id: string; invoiceId: string; invoiceNo: string; branchName: string; patient: { name: string; mrn: string } | null; payerId: string;
  payerName: string; amount: string; paidAmount: string; balance: string; dueDate: string; status: ReceivableStatus; overdue: boolean; createdAt: string }
export type ApprovalStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED';
export interface InvoiceVoidEntry { id: string; reason: string; status: ApprovalStatus; requestedByName: string; approvedByName: string | null; requestedAt: string;
  decidedAt: string | null; decisionNote: string | null; mine: boolean }
export interface VoidRequest extends InvoiceVoidEntry { invoiceId: string; invoiceNo: string | null; kind: string; netAmount: string; patientName: string | null;
  invoiceStatus: InvoiceStatus }
export interface Refund { id: string; refundNo: string; paymentId: string; receiptNo: string; invoiceId: string; invoiceNo: string | null; amount: string; reason: string;
  method: 'TUNAI' | 'TRANSFER'; reference: string | null; status: ApprovalStatus; requestedByName: string; requestedAt: string; approvedByName: string | null;
  decidedAt: string | null; decisionNote: string | null; patientName: string | null; mine: boolean }
export interface QrisCharge { id: string; invoiceId: string; provider: string; providerRef: string | null; qrPayload: string | null; amount: string;
  expiresAt: string; status: 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED' | 'CANCELLED'; paymentId: string | null; paidAt: string | null; callbackCount: number;
  settled: boolean; invoiceStatus: InvoiceStatus; simulator: boolean }
export type QrisIssue = 'PAID_NOT_SETTLED' | 'SETTLED_NOT_PAID' | 'AMOUNT_MISMATCH' | 'PAID_WITHOUT_PAYMENT';
export interface QrisReconciliation { date: string; paidCount: number; paidTotal: string; settledCount: number; settledTotal: string; batches: number;
  issues: { issue: QrisIssue; txnId: string | null; providerRef: string; invoiceId: string | null; invoiceNo: string | null; systemAmount: string | null;
    settledAmount: string | null; paidAt: string | null }[] }
