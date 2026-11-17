'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, CardContent, Input, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { api, errorText } from '../../../../lib/api';
import { fmtDate, fmtRupiah } from '../../../../lib/format';
import { useSession } from '../../../../lib/session';
import { ExportButton } from '../export-button';

interface Row { expiryDate: string; daysLeft: number; code: string; drugName: string; drugClass: string; batchNo: string; locationName: string; qty: number;
  uomName: string; value: string }
interface NearExpiryReport { rows: Row[]; days: number; today: string; allBranches: boolean; totals: { batches: number; expired: number; value: string } }
const qty = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 4 });

/**
 * Obat mendekati kedaluwarsa (RPT-FR-005): batch bersaldo yang kedaluwarsa dalam N hari (bawaan pengaturan klinik, 90 hari), termasuk yang
 * sudah kedaluwarsa (tidak dapat dikeluarkan). Urut tanggal kedaluwarsa; nilai = saldo × harga beli batch.
 */
export default function NearExpiryPage() {
  const s = useSession();
  const [branchId, setBranchId] = useState('');
  const [days, setDays] = useState('');
  const [includeExpired, setIncludeExpired] = useState('true');
  const [data, setData] = useState<NearExpiryReport>();
  const [error, setError] = useState<string>();
  const params = { branchId, days: /^\d+$/.test(days) ? days : '', includeExpired };
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  const load = useCallback(async () => {
    try { setData(await api<NearExpiryReport>(`/reports/near-expiry?${qs}`)); setError(undefined); } catch (e) { setError(errorText(e, 'Gagal memuat laporan')); }
  }, [qs]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Obat mendekati kedaluwarsa</h1>
        <ExportButton code="near-expiry" params={params} csvHref={`/api/v1/reports/near-expiry?${qs}&format=csv`} />
      </div>
      <div className="flex flex-wrap items-end gap-3" data-testid="report-filters">
        {s.me.branches.length > 1 ? (
          <label className="grid gap-1 text-xs">Cabang
            <Select aria-label="Cabang" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">Semua cabang (sesuai akses)</option>
              {s.me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </label>
        ) : null}
        <label className="grid gap-1 text-xs">Dalam (hari)
          <Input aria-label="Dalam berapa hari" type="number" min={1} max={730} className="w-28" placeholder={data ? String(data.days) : '90'} value={days}
            onChange={(e) => setDays(e.target.value)} />
        </label>
        <label className="grid gap-1 text-xs">Yang sudah kedaluwarsa
          <Select aria-label="Yang sudah kedaluwarsa" value={includeExpired} onChange={(e) => setIncludeExpired(e.target.value)}>
            <option value="true">Ikut ditampilkan</option><option value="false">Tidak ditampilkan</option>
          </Select>
        </label>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {data ? (
        <p className="text-sm" data-testid="report-totals">Batch <b>{data.totals.batches}</b> · Sudah kedaluwarsa <b>{data.totals.expired}</b> ·
          Nilai (harga beli) <b>{fmtRupiah(data.totals.value)}</b> · Batas {data.days} hari dari {fmtDate(data.today)}</p>
      ) : null}
      <Card>
        <CardContent className="pt-6">
          {!data ? <p role="status" className="text-sm text-muted-foreground">Memuat…</p> : data.rows.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada batch yang mendekati kedaluwarsa.</p> : (
            <Table>
              <THead><TR><TH>Kedaluwarsa</TH><TH className="text-right">Sisa hari</TH><TH>Obat</TH><TH>Batch</TH><TH>Lokasi</TH>
                <TH className="text-right">Jumlah</TH><TH className="text-right">Nilai</TH></TR></THead>
              <TBody>
                {data.rows.map((r) => (
                  <TR key={`${r.batchNo}|${r.code}|${r.locationName}`} data-testid="report-row">
                    <TD>{fmtDate(r.expiryDate)}</TD>
                    <TD className={`text-right tabular-nums ${r.daysLeft < 0 ? 'font-medium text-destructive' : ''}`}>{r.daysLeft < 0 ? `Lewat ${-r.daysLeft}` : r.daysLeft}</TD>
                    <TD>{r.drugName}<span className="block text-xs text-muted-foreground">{r.code} · {r.drugClass}</span></TD>
                    <TD>{r.batchNo}</TD><TD>{r.locationName}</TD>
                    <TD className="text-right tabular-nums">{qty(r.qty)} {r.uomName}</TD>
                    <TD className="text-right tabular-nums text-xs">{fmtRupiah(r.value)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Batch yang sudah kedaluwarsa tidak dapat dikeluarkan; tindak lanjuti dengan penyesuaian stok (pemusnahan/retur).
            {data && !data.allBranches ? ' Hanya cabang yang termasuk akses Anda.' : ''}</p>
        </CardContent>
      </Card>
    </div>
  );
}
