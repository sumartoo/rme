import type { ExportStatus } from './api';

export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(iso)) + ' WIB' : '—';

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const EXPORT_LABEL: Record<ExportStatus, string> = {
  QUEUED: 'Menunggu', RUNNING: 'Diproses', DONE: 'Siap diunduh', FAILED: 'Gagal', EXPIRED: 'Kedaluwarsa',
};
export const EXPORT_TONE: Record<ExportStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  QUEUED: 'neutral', RUNNING: 'info', DONE: 'success', FAILED: 'danger', EXPIRED: 'neutral',
};
