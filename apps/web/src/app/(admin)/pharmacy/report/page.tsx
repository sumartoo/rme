'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, CardContent, Input, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { StockReport, api, errorText } from '../../../../lib/api';
import { fmtRupiah, todayWib } from '../../../../lib/format';
import { useSession } from '../../../../lib/session';

const qty = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 4 });

/**
 * Laporan stok & mutasi (RPT-FR-005): saldo awal, masuk, keluar per jenis, penyesuaian, saldo akhir dan nilai harga beli
 * per obat untuk rentang tanggal di cabang aktif. Rincian mutasi diunduh sebagai CSV.
 */
export default function StockReportPage() {
  const s = useSession();
  const branchId = s.me.activeBranchId ?? '';
  const [from, setFrom] = useState(() => `${todayWib().slice(0, 7)}-01`);
  const [to, setTo] = useState(todayWib());
  const [data, setData] = useState<StockReport>();
  const [error, setError] = useState<string>();
  const qs = `from=${from}&to=${to}${branchId ? `&branchId=${branchId}` : ''}`;
  const load = useCallback(async () => {
    if (!from || !to) return;
    try { setData(await api<StockReport>(`/reports/stock?${qs}`)); setError(undefined); } catch (e) { setError(errorText(e, 'Gagal memuat laporan')); }
  }, [qs, from, to]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Laporan stok</h1>
        <Input aria-label="Dari tanggal" type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-sm">s.d.</span>
        <Input aria-label="Sampai tanggal" type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        <div className="ml-auto flex gap-3 text-sm">
          <a className="underline" href={`/api/v1/reports/stock?${qs}&format=csv`} data-testid="stock-csv">Unduh ringkasan (CSV)</a>
          <a className="underline" href={`/api/v1/reports/stock-movements?${qs}&format=csv`} data-testid="movements-csv">Unduh mutasi (CSV)</a>
        </div>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!data ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : data.rows.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada data.</p> : (
            <>
              <Table>
                <THead><TR><TH>Obat</TH><TH className="text-right">Awal</TH><TH className="text-right">Terima</TH><TH className="text-right">Retur masuk</TH>
                  <TH className="text-right">Resep</TH><TH className="text-right">Bebas</TH><TH className="text-right">Keluar lain</TH><TH className="text-right">Penyesuaian</TH>
                  <TH className="text-right">Akhir</TH><TH className="text-right">Nilai</TH></TR></THead>
                <TBody>
                  {data.rows.map((r) => (
                    <TR key={r.code} data-testid="report-row">
                      <TD>{r.drugName}<span className="block text-xs text-muted-foreground">{r.code} · {r.uomName}</span></TD>
                      <TD className="text-right tabular-nums">{qty(r.opening)}</TD>
                      <TD className="text-right tabular-nums">{qty(r.received)}</TD>
                      <TD className="text-right tabular-nums">{qty(r.returnedIn)}</TD>
                      <TD className="text-right tabular-nums">{qty(r.dispensed)}</TD>
                      <TD className="text-right tabular-nums">{qty(r.otcSold)}</TD>
                      <TD className="text-right tabular-nums">{qty(r.otherOut)}</TD>
                      <TD className="text-right tabular-nums">{r.adjusted > 0 ? '+' : ''}{qty(r.adjusted)}</TD>
                      <TD className="text-right font-medium tabular-nums">{qty(r.closing)}</TD>
                      <TD className="text-right tabular-nums text-xs">{fmtRupiah(r.closingValue)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <p className="mt-3 text-sm">Total nilai persediaan (harga beli): <strong>{fmtRupiah(data.totals.closingValue)}</strong></p>
              <p className="text-xs text-muted-foreground">Nilai memakai harga beli per batch; metode HPP (FIFO/rata-rata) belum diterapkan.</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
