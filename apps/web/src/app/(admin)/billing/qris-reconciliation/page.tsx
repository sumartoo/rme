'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Field, Input, TBody, TD, TH, THead, TR, Table, Textarea } from '@clinicrme/ui';
import { QrisIssue, QrisReconciliation, api, errorText } from '../../../../lib/api';
import { fmtDateTime, fmtRupiah } from '../../../../lib/format';

const ISSUE_LABEL: Record<QrisIssue, string> = {
  PAID_NOT_SETTLED: 'Lunas di sistem, belum ada di settlement',
  SETTLED_NOT_PAID: 'Ada di settlement, tidak ada transaksi lunas',
  AMOUNT_MISMATCH: 'Nominal berbeda',
  PAID_WITHOUT_PAYMENT: 'Uang masuk, pembayaran belum tercatat',
};
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

/**
 * Rekonsiliasi QRIS harian (BIL-FR-012): unggah berkas settlement penyedia (CSV `provider_ref,amount,settled_at`), lalu lihat
 * selisih terhadap transaksi QRIS yang tercatat lunas. Pada simulator, CSV contoh bisa diambil dari sistem.
 */
export default function QrisReconciliationPage() {
  const [date, setDate] = useState(today);
  const [rec, setRec] = useState<QrisReconciliation>();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setRec(await api<QrisReconciliation>(`/billing/reconciliation/qris?date=${date}`)); setError(undefined); }
    catch (e) { setError(errorText(e, 'Gagal memuat rekonsiliasi')); }
  }, [date]);
  useEffect(() => { void load(); }, [load]);
  async function upload() {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const r = await api<{ lineCount: number; matched: number }>('/billing/qris-settlements', { method: 'POST', body: { settlementDate: date, fileName, csv } });
      setNotice(`Settlement diunggah: ${r.lineCount} baris, ${r.matched} cocok dengan transaksi.`); setCsv(''); setFileName(undefined); await load();
    } catch (e) { setError(errorText(e, 'Gagal mengunggah settlement')); } finally { setBusy(false); }
  }
  async function simulated() {
    try { setCsv((await api<{ csv: string }>(`/billing/qris-settlements/simulated?date=${date}`)).csv); setFileName('simulasi.csv'); }
    catch (e) { setError(errorText(e, 'Gagal mengambil CSV simulasi')); }
  }
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-xl font-semibold">Rekonsiliasi QRIS</h1>
        <Field id="rec-date" label="Tanggal"><Input id="rec-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {rec ? (
        <Card>
          <CardContent className="flex flex-wrap gap-x-8 gap-y-1 pt-6 text-sm" data-testid="rec-summary">
            <span>QRIS lunas di sistem: <b>{rec.paidCount}</b> · <b className="tabular-nums">{fmtRupiah(rec.paidTotal)}</b></span>
            <span>Settlement: <b>{rec.settledCount}</b> baris · <b className="tabular-nums">{fmtRupiah(rec.settledTotal)}</b> ({rec.batches} berkas)</span>
            <span>Selisih: <b data-testid="rec-issue-count">{rec.issues.length}</b></span>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardContent className="pt-6">
          {!rec ? <p role="status" className="text-sm text-muted-foreground">Memuat…</p> : rec.issues.length === 0
            ? <p className="text-sm text-muted-foreground">{rec.batches ? 'Tidak ada selisih.' : rec.paidCount ? 'Belum ada berkas settlement untuk tanggal ini.' : 'Tidak ada transaksi QRIS pada tanggal ini.'}</p> : (
            <Table>
              <THead><TR><TH>Selisih</TH><TH>Ref. penyedia</TH><TH>Tagihan</TH><TH className="text-right">Sistem</TH><TH className="text-right">Settlement</TH><TH>Dibayar</TH></TR></THead>
              <TBody>
                {rec.issues.map((x, i) => (
                  <TR key={`${x.issue}-${x.providerRef}-${i}`} data-testid="rec-issue">
                    <TD><Badge tone="warning">{ISSUE_LABEL[x.issue]}</Badge></TD>
                    <TD className="font-mono text-xs">{x.providerRef}</TD>
                    <TD className="font-mono text-xs">{x.invoiceId ? <Link className="underline" href={`/billing/invoices/${x.invoiceId}`}>{x.invoiceNo}</Link> : '—'}</TD>
                    <TD className="text-right tabular-nums">{x.systemAmount ? fmtRupiah(x.systemAmount) : '—'}</TD>
                    <TD className="text-right tabular-nums">{x.settledAmount ? fmtRupiah(x.settledAmount) : '—'}</TD>
                    <TD className="text-xs">{x.paidAt ? fmtDateTime(x.paidAt) : '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="grid gap-3 pt-6 text-sm">
          <p className="font-medium">Unggah berkas settlement</p>
          <p className="text-xs text-muted-foreground">Format CSV: <code>provider_ref,amount,settled_at</code> (baris judul opsional). Tanggal settlement = tanggal di atas.</p>
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Berkas CSV" type="file" accept=".csv,text/csv" className="text-sm"
              onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await f.text()); setFileName(f.name); } }} />
            <Button size="sm" variant="ghost" onClick={() => void simulated()}>Ambil CSV simulasi</Button>
          </div>
          <Field id="rec-csv" label="Isi CSV"><Textarea id="rec-csv" rows={6} className="font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} /></Field>
          <div><Button disabled={busy || !csv.trim()} onClick={() => void upload()}>Unggah & cocokkan</Button></div>
        </CardContent>
      </Card>
    </div>
  );
}
