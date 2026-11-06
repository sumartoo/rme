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

/** Tanggal kalender (YYYY-MM-DD, tanpa zona waktu) → "31 Des 2030". */
export const fmtDate = (d: string | null | undefined) => {
  if (!d) return '—';
  const [y, m, day] = d.split('-').map(Number);
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, day)));
};

/** Sisa hari sampai tanggal kalender (negatif = lewat). Dipakai untuk tanda STR/SIP hampir/sudah habis. */
export const daysUntil = (d: string | null | undefined) => {
  if (!d) return null;
  const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) + 'T00:00:00Z');
  return Math.round((new Date(`${d}T00:00:00Z`).getTime() - today.getTime()) / 86_400_000);
};

export const FACILITY_TYPE_LABEL = { KLINIK_UTAMA: 'Klinik utama', KLINIK_PRATAMA: 'Klinik pratama', PRAKTIK_MANDIRI: 'Praktik mandiri' } as const;
export const UNIT_TYPE_LABEL = { POLI: 'Poli', RUANG: 'Ruang layanan', FARMASI: 'Farmasi', KASIR: 'Kasir', LAB: 'Laboratorium', LAINNYA: 'Lainnya' } as const;
export const PRACTITIONER_TYPE_LABEL = {
  DOKTER: 'Dokter', DOKTER_GIGI: 'Dokter gigi', DOKTER_SPESIALIS: 'Dokter spesialis', PERAWAT: 'Perawat', BIDAN: 'Bidan',
  APOTEKER: 'Apoteker', TTK: 'Tenaga teknis kefarmasian', ANALIS: 'Analis/ATLM', LAINNYA: 'Lainnya',
} as const;
export const TIMEZONE_LABEL = { 'Asia/Jakarta': 'WIB', 'Asia/Makassar': 'WITA', 'Asia/Jayapura': 'WIT' } as const;
export const SERVICE_TYPE_LABEL = { KONSULTASI: 'Konsultasi', TINDAKAN: 'Tindakan', PAKET: 'Paket', ADMINISTRASI: 'Administrasi', LAB: 'Laboratorium', LAINNYA: 'Lainnya' } as const;
export const PAYER_TYPE_LABEL = { UMUM: 'Umum', ASURANSI: 'Asuransi', PERUSAHAAN: 'Perusahaan', BPJS: 'BPJS' } as const;
/** Rupiah dari string desimal API (tanpa float untuk nilai besar). */
export const fmtRupiah = (s: string | null | undefined) => {
  if (s === null || s === undefined || s === '') return '—';
  const [int] = s.split('.');
  return 'Rp ' + int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
};
/** Tanggal hari ini (YYYY-MM-DD) di WIB. */
export const todayWib = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

// ------------------------------------------------------------------ Pasien (Stage 8)
export const SEX_LABEL = { L: 'Laki-laki', P: 'Perempuan', TIDAK_DIKETAHUI: 'Tidak diketahui' } as const;
export const IDENTITY_LABEL = {
  NIK: 'NIK (KTP/KK)', PASPOR: 'Paspor', KITAS: 'KITAS/KITAP', BAYI_IDENTITAS_IBU: 'Bayi — identitas ibu', TANPA_IDENTITAS: 'Tanpa identitas',
} as const;
export const CONSENT_TYPE_LABEL = { UMUM: 'Persetujuan umum', DATA_SHARING: 'Berbagi data', PORTAL: 'Portal pasien' } as const;
/** Umur dari tanggal lahir (YYYY-MM-DD): "34 th", bayi "5 bln" / "12 hr". */
export function fmtAge(birth: string): string {
  const [y, m, d] = birth.split('-').map(Number);
  const now = new Date(todayWib() + 'T00:00:00Z');
  let months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);
  if (now.getUTCDate() < d) months -= 1;
  if (months >= 24) return `${Math.floor(months / 12)} th`;
  if (months >= 1) return `${months} bln`;
  return `${Math.max(0, Math.round((now.getTime() - Date.UTC(y, m - 1, d)) / 86_400_000))} hr`;
}

// ------------------------------------------------------------------ Jadwal & janji temu (Stage 8)
export const DAY_LABEL = ['', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'] as const;
export const TZ_SHORT = { 'Asia/Jakarta': 'WIB', 'Asia/Makassar': 'WITA', 'Asia/Jayapura': 'WIT' } as const;
export const APPOINTMENT_STATUS = {
  BOOKED: { label: 'Terjadwal', tone: 'info' }, CHECKED_IN: { label: 'Hadir', tone: 'success' }, CANCELLED: { label: 'Dibatalkan', tone: 'neutral' },
  NO_SHOW: { label: 'Tidak hadir', tone: 'warning' }, RESCHEDULED: { label: 'Dijadwalkan ulang', tone: 'neutral' },
} as const;
/** "HH:MM" dari waktu ber-zona slot (string ISO dengan offset) — jam lokal cabang apa adanya. */
export const slotTime = (iso: string) => iso.slice(11, 16);
