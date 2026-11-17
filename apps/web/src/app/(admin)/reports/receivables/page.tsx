'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, CardContent, Input, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { api, errorText } from '../../../../lib/api';
import { fmtRupiah, todayWib } from '../../../../lib/format';
import { useSession } from '../../../../lib/session';
import { ExportButton } from '../export-button';

interface AgingRow { payerId: string; payerName: string; count: number; notDue: string; d1_30: string; d31_60: string; d61_90: string; over90: string; total: string }
interface Aging { rows: AgingRow[]; asOf: string; totals: Omit<AgingRow, 'payerId' | 'payerName'> }
const COLS: [keyof AgingRow, string][] = [['notDue', 'Belum jatuh tempo'], ['d1_30', '1–30 hari'], ['d31_60', '31–60 hari'], ['d61_90', '61–90 hari'], ['over90', '> 90 hari'], ['total', 'Total']];

/** Umur piutang penjamin (RPT-FR-007, OD-127): sisa piutang per tanggal posisi, dikelompokkan dari tanggal jatuh tempo. */
export default function ReceivableAgingPage() {
  const s = useSession();
  const [asOf, setAsOf] = useState(todayWib());
  const [branchId, setBranchId] = useState('');
  const [data, setData] = useState<Aging>();
  const [error, setError] = useState<string>();
  const qs = `asOf=${asOf}${branchId ? `&branchId=${branchId}` : ''}`;
  const load = useCallback(async () => {
    if (!asOf) return;
    try { setData(await api<Aging>(`/reports/receivables?${qs}`)); setError(undefined); } catch (e) { setError(errorText(e, 'Gagal memuat laporan')); }
  }, [qs, asOf]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Umur piutang penjamin</h1>
        <ExportButton code="receivables" params={Object.fromEntries(new URLSearchParams(qs))} csvHref={`/api/v1/reports/receivables?${qs}&format=csv`} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs">Posisi per tanggal<Input aria-label="Posisi per tanggal" type="date" className="w-40" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        {s.me.branches.length > 1 ? (
          <label className="grid gap-1 text-xs">Cabang
            <Select aria-label="Cabang" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">Semua cabang (sesuai akses)</option>{s.me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </label>
        ) : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!data ? <p role="status" className="text-sm text-muted-foreground">Memuat…</p> : data.rows.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada piutang terbuka per tanggal ini.</p> : (
            <Table>
              <THead><TR><TH>Penjamin</TH><TH className="text-right">Tagihan</TH>{COLS.map(([k, l]) => <TH key={k} className="text-right">{l}</TH>)}</TR></THead>
              <TBody>
                {data.rows.map((r) => (
                  <TR key={r.payerId} data-testid="report-row">
                    <TD>{r.payerName}</TD><TD className="text-right tabular-nums">{r.count}</TD>
                    {COLS.map(([k]) => <TD key={k} className={`text-right tabular-nums ${k === 'total' ? 'font-medium' : ''}`}>{fmtRupiah(String(r[k]))}</TD>)}
                  </TR>
                ))}
                <TR data-testid="report-total-row">
                  <TD className="font-semibold">Total</TD><TD className="text-right font-semibold tabular-nums">{data.totals.count}</TD>
                  {COLS.map(([k]) => <TD key={k} className="text-right font-semibold tabular-nums">{fmtRupiah(String(data.totals[k as keyof Aging['totals']]))}</TD>)}
                </TR>
              </TBody>
            </Table>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Sisa = nominal − pelunasan s.d. tanggal posisi. Umur dihitung dari tanggal jatuh tempo. Rincian per tagihan ada di Kasir › Piutang penjamin.</p>
        </CardContent>
      </Card>
    </div>
  );
}
