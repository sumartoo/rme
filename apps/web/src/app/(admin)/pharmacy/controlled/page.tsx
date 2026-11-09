'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, CardContent, Input, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { ControlledReport, api, errorText } from '../../../../lib/api';
import { useSession } from '../../../../lib/session';

const CLASS_LABEL: Record<string, string> = { NARKOTIKA: 'Narkotika', PSIKOTROPIKA: 'Psikotropika', PREKURSOR: 'Prekursor' };
const qty = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 4 });

/**
 * Laporan pemakaian bulanan obat golongan terbatas (OD-100): saldo awal, pemasukan, pengeluaran, penyesuaian, saldo akhir
 * per obat dari ledger mutasi stok cabang aktif. Format pelaporan resmi belum diverifikasi (REG-10).
 */
export default function ControlledReportPage() {
  const s = useSession();
  const branchId = s.me.activeBranchId ?? '';
  const [month, setMonth] = useState(() => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 7));
  const [data, setData] = useState<ControlledReport>();
  const [error, setError] = useState<string>();
  const qs = `month=${month}${branchId ? `&branchId=${branchId}` : ''}`;
  const load = useCallback(async () => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    try { setData(await api<ControlledReport>(`/reports/controlled-drugs?${qs}`)); setError(undefined); } catch (e) { setError(errorText(e, 'Gagal memuat laporan')); }
  }, [month, qs]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Laporan obat golongan terbatas</h1>
        <Input aria-label="Bulan" type="month" className="w-44" value={month} onChange={(e) => setMonth(e.target.value)} />
        <a className="ml-auto text-sm underline" href={`/api/v1/reports/controlled-drugs?${qs}&format=csv`} data-testid="controlled-csv">Unduh CSV</a>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Alert tone="info">Format laporan resmi (mis. SIPNAP) belum diverifikasi. Angka diambil dari catatan mutasi stok; periksa sebelum dilaporkan.</Alert>
      <Card>
        <CardContent className="pt-6">
          {!data ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : data.rows.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada obat golongan terbatas.</p> : (
            <Table>
              <THead><TR><TH>Obat</TH><TH>Golongan</TH><TH className="text-right">Saldo awal</TH><TH className="text-right">Masuk</TH><TH className="text-right">Keluar (resep)</TH>
                <TH className="text-right">Keluar lain</TH><TH className="text-right">Penyesuaian</TH><TH className="text-right">Saldo akhir</TH></TR></THead>
              <TBody>
                {data.rows.map((r) => (
                  <TR key={r.code} data-testid="controlled-row">
                    <TD>{r.drugName}<span className="block text-xs text-muted-foreground">{r.code} · {r.uomName}</span></TD>
                    <TD className="text-xs">{CLASS_LABEL[r.drugClass] ?? r.drugClass}</TD>
                    <TD className="text-right tabular-nums">{qty(r.opening)}</TD>
                    <TD className="text-right tabular-nums">{qty(r.received)}</TD>
                    <TD className="text-right tabular-nums">{qty(r.dispensed)}</TD>
                    <TD className="text-right tabular-nums">{qty(r.otherOut)}</TD>
                    <TD className="text-right tabular-nums">{r.adjusted > 0 ? '+' : ''}{qty(r.adjusted)}</TD>
                    <TD className="text-right font-medium tabular-nums">{qty(r.closing)}</TD>
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
