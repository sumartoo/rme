'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Card, CardContent, Field, Input, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { AnomalyReport, AnomalyRule, api, errorText } from '../../../../lib/api';
import { fmtDateTime, fmtRupiah } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

const RULE_ORDER: AnomalyRule[] = ['VOID_OUTSIDE_HOURS', 'REFUND_OUTSIDE_HOURS', 'DISCOUNT_OVER_LIMIT', 'VOIDS_PER_SHIFT', 'CASH_VARIANCE', 'CASH_AFTER_QRIS'];
const RULE_LABEL: Record<AnomalyRule, string> = {
  VOID_OUTSIDE_HOURS: 'Void di luar jam', REFUND_OUTSIDE_HOURS: 'Refund di luar jam', DISCOUNT_OVER_LIMIT: 'Diskon di atas batas',
  VOIDS_PER_SHIFT: 'Void per shift berlebih', CASH_VARIANCE: 'Selisih kas', CASH_AFTER_QRIS: 'Tunai + QRIS berlebih',
};
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

/**
 * Transaksi tidak wajar (BIL-FR-016; OD-041): tanda untuk ditinjau manajer, bukan blokir. Ambang diatur di Profil klinik.
 */
export default function AnomaliesPage() {
  const s = useSession();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [filter, setFilter] = useState<AnomalyRule | ''>('');
  const [rep, setRep] = useState<AnomalyReport>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try { setRep(await api<AnomalyReport>(`/reports/anomalies?from=${from}&to=${to}`)); setError(undefined); }
    catch (e) { setError(errorText(e, 'Gagal memuat laporan')); }
  }, [from, to]);
  useEffect(() => { void load(); }, [load]);
  const items = (rep?.items ?? []).filter((x) => !filter || x.rule === filter);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-xl font-semibold">Transaksi tidak wajar</h1>
        <Field id="an-from" label="Dari"><Input id="an-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field id="an-to" label="Sampai"><Input id="an-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        {can(s, 'report.export') ? <a className="mb-2 text-sm underline" href={`/api/v1/reports/anomalies?from=${from}&to=${to}&format=csv`}>Unduh CSV</a> : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {rep ? (
        <p className="text-xs text-muted-foreground">Ambang: jam kasir {rep.thresholds.billingHoursStart}–{rep.thresholds.billingHoursEnd}, maks.
          {' '}{rep.thresholds.voidsPerShiftLimit} void per shift, toleransi kas {fmtRupiah(String(rep.thresholds.cashVarianceTolerance))}. Ubah di Profil klinik.</p>
      ) : null}
      {rep ? (
        <div className="flex flex-wrap gap-2" data-testid="anomaly-counts">
          <button type="button" onClick={() => setFilter('')} className="text-sm"><Badge tone={filter === '' ? 'info' : 'neutral'}>Semua ({rep.items.length})</Badge></button>
          {RULE_ORDER.map((r) => (
            <button key={r} type="button" onClick={() => setFilter(r)} className="text-sm">
              <Badge tone={filter === r ? 'info' : rep.counts[r] ? 'warning' : 'neutral'}>{RULE_LABEL[r]} ({rep.counts[r]})</Badge>
            </button>
          ))}
        </div>
      ) : null}
      <Card>
        <CardContent className="pt-6">
          {!rep ? <p role="status" className="text-sm text-muted-foreground">Memuat…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada transaksi yang ditandai.</p> : (
            <Table>
              <THead><TR><TH>Jenis</TH><TH>Waktu</TH><TH>Petugas</TH><TH>Tagihan</TH><TH className="text-right">Nominal</TH><TH>Keterangan</TH></TR></THead>
              <TBody>
                {items.map((x, i) => (
                  <TR key={`${x.rule}-${i}`} data-testid="anomaly-row">
                    <TD><Badge tone="warning">{x.label}</Badge><span className="block text-xs text-muted-foreground">{x.branchName}</span></TD>
                    <TD className="text-xs">{fmtDateTime(x.at)}</TD>
                    <TD className="text-xs">{x.userName ?? '—'}</TD>
                    <TD className="font-mono text-xs">{x.invoiceId ? <Link className="underline" href={`/billing/invoices/${x.invoiceId}`}>{x.invoiceNo}</Link> : '—'}</TD>
                    <TD className="text-right tabular-nums">{x.amount ? fmtRupiah(x.amount) : '—'}</TD>
                    <TD className="text-xs">{x.detail}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
