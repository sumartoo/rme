/**
 * Mesin status tenant (PLT-FR-005, STAGE_05 §3.2). Cermin dari app.tenant_status_transition_allowed() di migrasi 0003;
 * database tetap penegak terakhir (trigger), fungsi ini untuk pesan error yang jelas & UI. Kesetaraan keduanya diuji (P07).
 */
export const TENANT_STATUSES = ['PROVISIONING', 'TRIAL', 'ACTIVE', 'GRACE', 'SUSPENDED', 'TERMINATED'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

const TRANSITIONS: Readonly<Record<TenantStatus, readonly TenantStatus[]>> = {
  PROVISIONING: ['TRIAL', 'ACTIVE'],
  TRIAL: ['ACTIVE', 'GRACE', 'SUSPENDED'],
  ACTIVE: ['GRACE', 'SUSPENDED'],
  GRACE: ['ACTIVE', 'SUSPENDED'],
  SUSPENDED: ['ACTIVE', 'TERMINATED'],   // terminasi hanya setelah ditangguhkan
  TERMINATED: [],                        // final; data disimpan sampai masa retensi (PLT-FR-013)
};

export function allowedTransitions(from: TenantStatus): readonly TenantStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(from: TenantStatus, to: TenantStatus): boolean {
  return allowedTransitions(from).includes(to);
}
