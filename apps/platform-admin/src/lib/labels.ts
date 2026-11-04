import type { TenantStatus } from './api';

export const STATUS_LABEL: Record<TenantStatus, string> = {
  PROVISIONING: 'Disiapkan', TRIAL: 'Uji coba', ACTIVE: 'Aktif', GRACE: 'Masa tenggang', SUSPENDED: 'Ditangguhkan', TERMINATED: 'Dihentikan',
};
export const STATUS_TONE: Record<TenantStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  PROVISIONING: 'neutral', TRIAL: 'info', ACTIVE: 'success', GRACE: 'warning', SUSPENDED: 'danger', TERMINATED: 'neutral',
};
/** Dampak tiap status bagi klinik (PLT-FR-006, PLT-FR-013) — ditampilkan sebelum konfirmasi. */
export const STATUS_EFFECT: Partial<Record<TenantStatus, string>> = {
  ACTIVE: 'Semua user klinik dapat masuk seperti biasa.',
  GRACE: 'Klinik tetap berjalan normal selama masa tenggang pembayaran.',
  SUSPENDED: 'Hanya admin klinik yang dapat masuk (untuk pembayaran/ekspor). Sesi user lain langsung diblokir.',
  TERMINATED: 'Klinik tidak dapat diakses sama sekali. Data tetap disimpan sampai masa retensi berakhir. Status ini final — tidak bisa dibatalkan.',
};
export const TENANT_TYPE_LABEL: Record<string, string> = {
  KLINIK_UTAMA: 'Klinik utama', KLINIK_PRATAMA: 'Klinik pratama', PRAKTIK_MANDIRI: 'Praktik mandiri',
};

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeZone: 'Asia/Jakarta' }).format(new Date(iso)) : '—';

export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(iso)) + ' WIB' : '—';

/** Pilihan durasi break-glass (15 menit – 8 jam, PLT-FR-009). */
export const SUPPORT_DURATIONS: { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 menit' }, { minutes: 30, label: '30 menit' }, { minutes: 60, label: '1 jam' },
  { minutes: 120, label: '2 jam' }, { minutes: 240, label: '4 jam' }, { minutes: 480, label: '8 jam (maksimum)' },
];
export const ACTOR_KIND_LABEL: Record<string, string> = {
  USER: 'User klinik', SYSTEM: 'Sistem', PLATFORM: 'Admin platform', PLATFORM_SUPPORT: 'Support platform',
};
