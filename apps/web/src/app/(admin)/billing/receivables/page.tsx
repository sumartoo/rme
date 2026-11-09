'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Card, CardContent, Select, Switch, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { Receivable, ReceivableStatus, api, errorText } from '../../../../lib/api';
import { fmtDate, fmtRupiah } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

const STATUS_LABEL: Record<ReceivableStatus, string> = { OPEN: 'Belum dibayar', PARTIAL: 'Dibayar sebagian', PAID: 'Lunas', WRITTEN_OFF: 'Dihapusbukukan' };

/** Piutang porsi penjamin (BIL-FR-013; OD-108): terbentuk saat tagihan terbit. Pencatatan pelunasan menyusul (batch 4). */
export default function ReceivablesPage() {
  const s = useSession();
  const [items, setItems] = useState<Receivable[]>();
  const [status, setStatus] = useState<'' | ReceivableStatus>('OPEN');
  const [overdue, setOverdue] = useState(false);
  const [error, setError] = useState<string>();
  const canInvoice = can(s, 'billing.invoice.read');
  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (status) p.set('status', status);
      if (overdue) p.set('overdue', 'true');
      setItems(await api<Receivable[]>(`/receivables?${p}`)); setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal memuat piutang')); }
  }, [status, overdue]);
  useEffect(() => { void load(); }, [load]);
  const total = (items ?? []).reduce((n, r) => n + Number(r.balance), 0);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Piutang penjamin</h1>
        <Select aria-label="Status" className="w-44" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="">Semua status</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-sm"><Switch checked={overdue} onChange={(e) => setOverdue(e.target.checked)} aria-label="Hanya yang terlambat" /> Hanya yang terlambat</label>
        {items ? <span className="ml-auto text-sm">Saldo: <b className="tabular-nums" data-testid="receivable-total">{fmtRupiah(total.toFixed(2))}</b></span> : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada piutang.</p> : (
            <Table>
              <THead><TR><TH>Penjamin</TH><TH>Tagihan</TH><TH>Pasien</TH><TH className="text-right">Piutang</TH><TH className="text-right">Dibayar</TH>
                <TH className="text-right">Saldo</TH><TH>Jatuh tempo</TH><TH>Status</TH></TR></THead>
              <TBody>
                {items.map((r) => (
                  <TR key={r.id} data-testid="receivable-row">
                    <TD>{r.payerName}<span className="block text-xs text-muted-foreground">{r.branchName}</span></TD>
                    <TD className="font-mono text-xs">{canInvoice ? <Link className="underline" href={`/billing/invoices/${r.invoiceId}`}>{r.invoiceNo}</Link> : r.invoiceNo}</TD>
                    <TD>{r.patient ? <>{r.patient.name}<span className="block text-xs text-muted-foreground">RM {r.patient.mrn}</span></> : '—'}</TD>
                    <TD className="text-right tabular-nums">{fmtRupiah(r.amount)}</TD>
                    <TD className="text-right tabular-nums">{fmtRupiah(r.paidAmount)}</TD>
                    <TD className="text-right tabular-nums">{fmtRupiah(r.balance)}</TD>
                    <TD>{fmtDate(r.dueDate)}{r.overdue ? <Badge tone="danger" className="ml-2">Terlambat</Badge> : null}</TD>
                    <TD>{STATUS_LABEL[r.status]}</TD>
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
