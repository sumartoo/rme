'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, CardContent, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { api, errorText } from '../../../../lib/api';
import { fmtRupiah } from '../../../../lib/format';
import { ReportFilters, defaultFilters, filterQs } from '../report-filters';

type Row = Record<string, string | number>;
interface Revenue { columns: { key: string; label: string; type: string }[]; rows: Row[]; totals: Record<string, string | number>; view: 'billed' | 'cash'; groupBy: string }

/**
 * Pendapatan (RPT-FR-003, OD-126): (a) tagihan terbit per kategori/layanan/penjamin/hari — porsi pasien & penjamin; (b) penerimaan kas per metode/hari
 * (pembayaran + pelunasan piutang − refund). Bukan laporan akuntansi resmi.
 */
export default function RevenueReportPage() {
  const [f, setF] = useState(defaultFilters);
  const [view, setView] = useState<'billed' | 'cash'>('billed');
  const [groupBy, setGroupBy] = useState('category');
  const [data, setData] = useState<Revenue>();
  const [error, setError] = useState<string>();
  const qs = `${filterQs(view === 'cash' ? { ...f, payerType: '' } : f)}&view=${view}&groupBy=${groupBy}`;
  const load = useCallback(async () => {
    if (!f.from || !f.to) return;
    try { setData(await api<Revenue>(`/reports/revenue?${qs}`)); setError(undefined); } catch (e) { setError(errorText(e, 'Gagal memuat laporan')); }
  }, [qs, f.from, f.to]);
  useEffect(() => { void load(); }, [load]);
  const groups: [string, string][] = view === 'billed'
    ? [['category', 'Kategori'], ['service', 'Layanan/obat'], ['payer', 'Penjamin'], ['day', 'Hari']]
    : [['payer', 'Metode bayar'], ['day', 'Hari']];
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Laporan pendapatan</h1>
        <a className="text-sm underline" href={`/api/v1/reports/revenue?${qs}&format=csv`} data-testid="report-csv">Unduh CSV</a>
      </div>
      <ReportFilters value={f} onChange={setF} payer={view === 'billed'}>
        <label className="grid gap-1 text-xs">Sudut pandang
          <Select aria-label="Sudut pandang" value={view} onChange={(e) => { const v = e.target.value as 'billed' | 'cash'; setView(v); setGroupBy(v === 'cash' ? 'payer' : 'category'); }}>
            <option value="billed">Tagihan terbit</option><option value="cash">Penerimaan kas</option>
          </Select>
        </label>
        <label className="grid gap-1 text-xs">Kelompokkan
          <Select aria-label="Kelompokkan" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>{groups.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </label>
      </ReportFilters>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!data ? <p role="status" className="text-sm text-muted-foreground">Memuat…</p> : data.rows.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada data pada rentang ini.</p> : (
            <Table>
              <THead><TR>{data.columns.map((c) => <TH key={c.key} className={c.type === 'string' ? '' : 'text-right'}>{c.key === 'groupLabel' ? groups.find(([v]) => v === data.groupBy)?.[1] ?? c.label : c.label}</TH>)}</TR></THead>
              <TBody>
                {data.rows.map((r) => (
                  <TR key={String(r['groupKey'])} data-testid="report-row">
                    {data.columns.map((c) => <TD key={c.key} className={c.type === 'string' ? '' : 'text-right tabular-nums'}>{c.type === 'money' ? fmtRupiah(String(r[c.key])) : r[c.key]}</TD>)}
                  </TR>
                ))}
                <TR data-testid="report-total-row">
                  {data.columns.map((c, i) => <TD key={c.key} className={`font-semibold ${c.type === 'string' ? '' : 'text-right tabular-nums'}`}>
                    {i === 0 ? 'Total' : c.type === 'money' && data.totals[c.key] !== undefined ? fmtRupiah(String(data.totals[c.key])) : ''}</TD>)}
                </TR>
              </TBody>
            </Table>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            {view === 'billed' ? `Tagihan terbit (tidak termasuk draf & void) menurut tanggal terbit${data ? ` — ${data.totals['invoices']} tagihan` : ''}.`
              : 'Pembayaran menurut tanggal diterima, pelunasan piutang menurut tanggal bayar, dikurangi refund yang disetujui.'} Bukan laporan akuntansi resmi.</p>
        </CardContent>
      </Card>
    </div>
  );
}
