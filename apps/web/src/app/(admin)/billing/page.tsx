'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { BillingWorkItem, Invoice, InvoiceStatus, api, errorText } from '../../../lib/api';
import { PAYER_TYPE_LABEL, fmtDateTime, fmtRupiah } from '../../../lib/format';
import { can, useSession } from '../../../lib/session';

const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = { DRAFT: 'Draf', ISSUED: 'Terbit', PARTIALLY_PAID: 'Dibayar sebagian', PAID: 'Lunas', VOID: 'Void' };
const TYPE_LABEL: Record<BillingWorkItem['type'], string> = { ENCOUNTER: 'Kunjungan', DRUG: 'Obat susulan', OTC: 'Obat bebas' };

/**
 * Kasir (BIL-FR-001): antrean tagihan — kunjungan yang diteruskan ke kasir, obat susulan (alur kasir-dulu, OD-107), dan
 * penjualan obat bebas menunggu bayar (OD-113). Manajer melihat diskon yang menunggu persetujuan (OD-041).
 */
export default function BillingPage() {
  const s = useSession();
  const router = useRouter();
  const branchId = s.me.activeBranchId ?? '';
  const canIssue = can(s, 'billing.invoice.issue');
  const canApprove = can(s, 'billing.invoice.void.approve');
  const [items, setItems] = useState<BillingWorkItem[]>();
  const [pending, setPending] = useState<Invoice[]>([]);
  const [filter, setFilter] = useState<'' | BillingWorkItem['type']>('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const load = useCallback(async () => {
    try {
      setItems(await api<BillingWorkItem[]>(`/billing/worklist${branchId ? `?branchId=${branchId}` : ''}`));
      if (canApprove) setPending(await api<Invoice[]>(`/invoices?status=DRAFT&discountPending=true${branchId ? `&branchId=${branchId}` : ''}`));
      setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal memuat antrean kasir')); }
  }, [branchId, canApprove]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 10_000);
    return () => clearInterval(t);
  }, [load]);
  async function open(x: BillingWorkItem) {
    if (x.invoice && x.type !== 'DRUG') { router.push(`/billing/invoices/${x.invoice.id}`); return; }
    setBusy(x.refId); setError(undefined);
    try {
      const inv = await api<Invoice>(x.type === 'OTC' ? `/billing/otc-sales/${x.refId}/invoice` : `/billing/encounters/${x.refId}/invoice`, { method: 'POST' });
      router.push(`/billing/invoices/${inv.id}`);
    } catch (e) { setError(errorText(e, 'Gagal membuat tagihan')); } finally { setBusy(undefined); }
  }
  const shown = (items ?? []).filter((x) => !filter || x.type === filter);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Tagihan</h1>
        <Select aria-label="Jenis" className="w-44" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="">Semua jenis</option>
          {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Button size="sm" variant="ghost" onClick={() => void load()}>Muat ulang</Button>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {canApprove && pending.length ? (
        <Card data-testid="discount-pending">
          <CardContent className="grid gap-2 pt-6 text-sm">
            <p className="font-medium">Diskon menunggu persetujuan</p>
            {pending.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-2">
                <span>{p.patient?.name ?? p.customerName ?? '—'} · {p.encounterNo ?? p.saleNo}</span>
                <span className="text-xs text-muted-foreground">{p.lines.filter((l) => l.discountStatus === 'PENDING').map((l) => `${l.description} −${fmtRupiah(l.discountAmount)}`).join(', ')}</span>
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => router.push(`/billing/invoices/${p.id}`)}>Tinjau</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : shown.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada antrean tagihan.</p> : (
            <Table>
              <THead><TR><TH>Jenis</TH><TH>Pasien / pembeli</TH><TH>Penjamin</TH><TH>Tagihan</TH><TH className="text-right">Dibayar pasien</TH><TH /></TR></THead>
              <TBody>
                {shown.map((x) => (
                  <TR key={`${x.type}-${x.refId}`} data-testid="billing-row">
                    <TD><Badge tone={x.type === 'ENCOUNTER' ? 'neutral' : 'warning'}>{TYPE_LABEL[x.type]}</Badge>
                      <span className="block font-mono text-xs text-muted-foreground">{x.refNo}</span></TD>
                    <TD>{x.patient ? <>{x.patient.name}<span className="block text-xs text-muted-foreground">RM {x.patient.mrn}{x.unitName ? ` · ${x.unitName}` : ''}</span></> : x.customerName ?? 'Pembeli umum'}
                      <span className="block text-xs text-muted-foreground">{fmtDateTime(x.at)}</span></TD>
                    <TD className="text-xs">{x.payerName ?? PAYER_TYPE_LABEL[x.payerType]}</TD>
                    <TD className="text-xs">{x.invoice ? <>{INVOICE_STATUS_LABEL[x.invoice.status]}{x.invoice.invoiceNo ? ` · ${x.invoice.invoiceNo}` : ''}</> : 'Belum dibuat'}</TD>
                    <TD className="text-right tabular-nums">{x.invoice ? fmtRupiah(x.invoice.patientPortion) : '—'}</TD>
                    <TD className="text-right">
                      {x.invoice && x.type !== 'DRUG' ? <Button size="sm" variant="outline" onClick={() => void open(x)}>Buka</Button>
                        : canIssue ? <Button size="sm" disabled={busy === x.refId} onClick={() => void open(x)}>Buat tagihan</Button> : null}
                    </TD>
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
