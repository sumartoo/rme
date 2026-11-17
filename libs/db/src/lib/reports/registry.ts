import type { z } from 'zod';
import { type Q, type ReportResult } from './common';
import { DxQ, VisitsQ, topDiagnoses, visits } from './clinical';
import { AgingQ, ClosingQ, RevenueQ, cashierClosing, receivables, revenue } from './finance';
import { ControlledQ, NearExpiryQ, StockQ, controlledDrugs, nearExpiry, stockMovements, stockSummary } from './pharmacy';

/** Batas baris ekspor langsung; di atasnya diproses worker (OD-128). */
export const SYNC_EXPORT_ROWS = 10_000;
/** Batas keras baris satu ekspor (mutasi stok terperinci). */
export const MAX_EXPORT_ROWS = 100_000;

export interface ReportDef {
  code: string; title: string; permission: string;
  schema: z.ZodType;
  run(tx: Q, f: never, scope: string[] | null, opts?: { forExport?: boolean }): Promise<ReportResult>;
  filename(f: Record<string, unknown>, r?: ReportResult): string;
}
const def = <S extends z.ZodType>(d: { code: string; title: string; permission: string; schema: S;
  run(tx: Q, f: z.infer<S>, scope: string[] | null, opts?: { forExport?: boolean }): Promise<ReportResult>; filename(f: z.infer<S>, r?: ReportResult): string }) => d as unknown as ReportDef;

/** Katalog laporan standar MVP (Stage 14). Kode dipakai URL ekspor `/reports/{code}/exports`. */
export const REPORTS: Record<string, ReportDef> = Object.fromEntries([
  def({ code: 'visits', title: 'Laporan kunjungan', permission: 'report.operational.read', schema: VisitsQ, run: visits,
    filename: (f) => `kunjungan-${f.from}-${f.to}` }),
  def({ code: 'top-diagnoses', title: 'Laporan 10 besar diagnosis', permission: 'report.clinical.read', schema: DxQ, run: topDiagnoses,
    filename: (f) => `10-besar-diagnosis-${f.from}-${f.to}` }),
  def({ code: 'revenue', title: 'Laporan pendapatan', permission: 'report.finance.read', schema: RevenueQ, run: revenue,
    filename: (f) => `pendapatan-${f.view === 'cash' ? 'kas' : 'tagihan'}-${f.from}-${f.to}` }),
  def({ code: 'cashier-closing', title: 'Laporan closing kasir', permission: 'report.finance.read', schema: ClosingQ, run: cashierClosing,
    filename: (f) => `closing-kasir-${f.from}-${f.to}` }),
  def({ code: 'receivables', title: 'Laporan umur piutang penjamin', permission: 'report.finance.read', schema: AgingQ, run: receivables,
    filename: (f, r) => `umur-piutang-${String(r?.extra?.['asOf'] ?? f.asOf ?? 'hari-ini')}` }),
  def({ code: 'stock', title: 'Laporan stok', permission: 'report.pharmacy.read', schema: StockQ, run: stockSummary,
    filename: (f) => `stok-${f.from}-${f.to}` }),
  def({ code: 'stock-movements', title: 'Laporan mutasi stok', permission: 'report.pharmacy.read', schema: StockQ,
    run: (tx, f, scope, o) => stockMovements(tx, f, scope, o?.forExport ? MAX_EXPORT_ROWS : undefined), filename: (f) => `mutasi-stok-${f.from}-${f.to}` }),
  def({ code: 'controlled-drugs', title: 'Laporan obat golongan terbatas', permission: 'report.pharmacy.controlled', schema: ControlledQ, run: controlledDrugs,
    filename: (f) => `obat-terbatas-${f.month}` }),
  def({ code: 'near-expiry', title: 'Laporan obat mendekati kedaluwarsa', permission: 'report.pharmacy.read', schema: NearExpiryQ, run: nearExpiry,
    filename: () => 'mendekati-kedaluwarsa' }),
].map((d) => [d.code, d]));

/** Label filter untuk preamble/watermark ekspor (tanpa data pasien). */
const LABELS: Record<string, string> = {
  from: 'Dari', to: 'Sampai', month: 'Bulan', asOf: 'Posisi per', branchId: 'Cabang', unitId: 'Poli', practitionerId: 'Dokter', payerType: 'Penjamin',
  period: 'Periode', groupBy: 'Kelompok', scope: 'Diagnosis', limit: 'Jumlah', view: 'Sudut pandang', locationId: 'Lokasi', drugId: 'Obat', type: 'Jenis mutasi',
  days: 'Hari', includeExpired: 'Termasuk kedaluwarsa',
};
export const describeFilters = (f: Record<string, unknown>, names: Record<string, string> = {}) =>
  Object.entries(f).filter(([k, v]) => k !== 'format' && v !== undefined && v !== '')
    .map(([k, v]) => `${LABELS[k] ?? k}: ${names[String(v)] ?? String(v)}`).join(' · ');
