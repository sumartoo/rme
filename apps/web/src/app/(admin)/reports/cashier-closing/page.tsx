'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Card, CardContent, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { api, errorText } from '../../../../lib/api';
import { fmtRupiah } from '../../../../lib/format';
import { ReportFilters, defaultFilters, filterQs } from '../report-filters';
import { ExportButton } from '../export-button';

interface ClosingRow { shiftId: string; date: string; branchName: string; cashierName: string; status: string; statusLabel: string; openingCash: string; cashIn: string;
  cashRefunds: string; expectedCash: string; countedCash: string | null; variance: string | null; nonCash: string; verifiedByName: string | null; varianceNote: string | null }
interface Closing { rows: ClosingRow[]; totals: { shifts: number; open: number; unverified: number; cashIn: string; cashRefunds: string; nonCash: string; variance: string } }
const TONE: Record<string, 'info' | 'warning' | 'success'> = { OPEN: 'info', CLOSED: 'warning', VERIFIED: 'success' };

/** Closing kasir (RPT-FR-004, OD-127): rekap shift per tanggal buka — kas awal, tunai masuk, refund tunai, kas seharusnya, dihitung, selisih, non-tunai. */
export default function CashierClosingReportPage() {
  const [f, setF] = useState(defaultFilters);
  const [data, setData] = useState<Closing>();
  const [error, setError] = useState<string>();
  const qs = filterQs({ ...f, payerType: '' });
  const load = useCallback(async () => {
    if (!f.from || !f.to) return;
    try { setData(await api<Closing>(`/reports/cashier-closing?${qs}`)); setError(undefined); } catch (e) { setError(errorText(e, 'Gagal memuat laporan')); }
  }, [qs, f.from, f.to]);
  useEffect(() => { void load(); }, [load]);
  const t = data?.totals;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Closing kasir</h1>
        <ExportButton code="cashier-closing" params={Object.fromEntries(new URLSearchParams(qs))} csvHref={`/api/v1/reports/cashier-closing?${qs}&format=csv`} />
      </div>
      <ReportFilters value={f} onChange={setF} payer={false} />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {t ? (
        <p className="text-sm" data-testid="report-totals">Shift <b>{t.shifts}</b> (terbuka {t.open}, belum diverifikasi {t.unverified}) · Tunai masuk <b>{fmtRupiah(t.cashIn)}</b> ·
          Refund tunai <b>{fmtRupiah(t.cashRefunds)}</b> · Non-tunai <b>{fmtRupiah(t.nonCash)}</b> · Total selisih <b>{fmtRupiah(t.variance)}</b></p>
      ) : null}
      <Card>
        <CardContent className="pt-6">
          {!data ? <p role="status" className="text-sm text-muted-foreground">Memuat…</p> : data.rows.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada shift pada rentang ini.</p> : (
            <Table>
              <THead><TR><TH>Tanggal</TH><TH>Kasir</TH><TH>Status</TH><TH className="text-right">Kas awal</TH><TH className="text-right">Tunai masuk</TH><TH className="text-right">Refund tunai</TH>
                <TH className="text-right">Seharusnya</TH><TH className="text-right">Dihitung</TH><TH className="text-right">Selisih</TH><TH className="text-right">Non-tunai</TH></TR></THead>
              <TBody>
                {data.rows.map((r) => (
                  <TR key={r.shiftId} data-testid="report-row">
                    <TD>{r.date}<span className="block text-xs text-muted-foreground">{r.branchName}</span></TD>
                    <TD>{r.cashierName}</TD>
                    <TD><Badge tone={TONE[r.status] ?? 'info'}>{r.statusLabel}</Badge>{r.verifiedByName ? <span className="block text-xs text-muted-foreground">oleh {r.verifiedByName}</span> : null}</TD>
                    <TD className="text-right tabular-nums">{fmtRupiah(r.openingCash)}</TD><TD className="text-right tabular-nums">{fmtRupiah(r.cashIn)}</TD>
                    <TD className="text-right tabular-nums">{fmtRupiah(r.cashRefunds)}</TD><TD className="text-right tabular-nums">{fmtRupiah(r.expectedCash)}</TD>
                    <TD className="text-right tabular-nums">{r.countedCash ? fmtRupiah(r.countedCash) : '—'}</TD>
                    <TD className={`text-right tabular-nums ${r.variance && Number(r.variance) !== 0 ? 'font-semibold text-destructive' : ''}`} title={r.varianceNote ?? undefined}>
                      {r.variance !== null ? fmtRupiah(r.variance) : '—'}</TD>
                    <TD className="text-right tabular-nums">{fmtRupiah(r.nonCash)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Kas seharusnya = kas awal + tunai masuk − refund tunai disetujui. Tanggal = tanggal shift dibuka (zona waktu cabang).</p>
        </CardContent>
      </Card>
    </div>
  );
}
