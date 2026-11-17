'use client';
import { Input, Select } from '@clinicrme/ui';
import { todayWib } from '../../../lib/format';
import { useSession } from '../../../lib/session';

export interface Filters { from: string; to: string; branchId: string; payerType: string }
export const defaultFilters = (): Filters => ({ from: `${todayWib().slice(0, 7)}-01`, to: todayWib(), branchId: '', payerType: '' });
export const filterQs = (f: Partial<Filters>) => new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();

/** Filter seragam laporan (Stage 14; OD-124, OD-129): rentang tanggal (zona waktu cabang), cabang, jenis penjamin. */
export function ReportFilters({ value, onChange, children, payer = true }: { value: Filters; onChange: (f: Filters) => void; children?: React.ReactNode; payer?: boolean }) {
  const s = useSession();
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="report-filters">
      <label className="grid gap-1 text-xs">Dari<Input aria-label="Dari tanggal" type="date" className="w-40" value={value.from} onChange={set('from')} /></label>
      <label className="grid gap-1 text-xs">Sampai<Input aria-label="Sampai tanggal" type="date" className="w-40" value={value.to} onChange={set('to')} /></label>
      {s.me.branches.length > 1 ? (
        <label className="grid gap-1 text-xs">Cabang
          <Select aria-label="Cabang" value={value.branchId} onChange={set('branchId')}>
            <option value="">Semua cabang (sesuai akses)</option>
            {s.me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </label>
      ) : null}
      {payer ? (
        <label className="grid gap-1 text-xs">Penjamin
          <Select aria-label="Penjamin" value={value.payerType} onChange={set('payerType')}>
            <option value="">Semua</option><option value="UMUM">Umum</option><option value="ASURANSI">Asuransi</option>
            <option value="PERUSAHAAN">Perusahaan</option><option value="BPJS">BPJS</option>
          </Select>
        </label>
      ) : null}
      {children}
    </div>
  );
}
