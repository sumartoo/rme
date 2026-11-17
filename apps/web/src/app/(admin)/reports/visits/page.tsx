'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, CardContent, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { api, errorText } from '../../../../lib/api';
import { ReportFilters, defaultFilters, filterQs } from '../report-filters';

interface VisitRow { period: string; groupKey: string; groupLabel: string; visits: number; uniquePatients: number; newPatients: number; returningPatients: number;
  waiting: number; inService: number; finished: number }
interface VisitReport { rows: VisitRow[]; totals: { visits: number; uniquePatients: number; newPatients: number; returningPatients: number; noShows: number }; allBranches: boolean }
const GROUPS: [string, string][] = [['none', 'Tanpa pengelompokan'], ['branch', 'Cabang'], ['unit', 'Poli'], ['practitioner', 'Dokter'], ['payer', 'Penjamin']];

/** Laporan kunjungan (RPT-FR-001, OD-124): kunjungan tidak batal per tanggal kedatangan; pasien unik, baru/lama, status; no-show terpisah. */
export default function VisitReportPage() {
  const [f, setF] = useState(defaultFilters);
  const [period, setPeriod] = useState('day');
  const [groupBy, setGroupBy] = useState('none');
  const [data, setData] = useState<VisitReport>();
  const [error, setError] = useState<string>();
  const qs = `${filterQs(f)}&period=${period}&groupBy=${groupBy}`;
  const load = useCallback(async () => {
    if (!f.from || !f.to) return;
    try { setData(await api<VisitReport>(`/reports/visits?${qs}`)); setError(undefined); } catch (e) { setError(errorText(e, 'Gagal memuat laporan')); }
  }, [qs, f.from, f.to]);
  useEffect(() => { void load(); }, [load]);
  const t = data?.totals;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Laporan kunjungan</h1>
        <a className="text-sm underline" href={`/api/v1/reports/visits?${qs}&format=csv`} data-testid="report-csv">Unduh CSV</a>
      </div>
      <ReportFilters value={f} onChange={setF}>
        <label className="grid gap-1 text-xs">Periode
          <Select aria-label="Periode" value={period} onChange={(e) => setPeriod(e.target.value)}><option value="day">Harian</option><option value="month">Bulanan</option></Select>
        </label>
        <label className="grid gap-1 text-xs">Kelompokkan
          <Select aria-label="Kelompokkan" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>{GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </label>
      </ReportFilters>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {t ? (
        <p className="text-sm" data-testid="report-totals">Total kunjungan <b>{t.visits}</b> · Pasien unik <b>{t.uniquePatients}</b> · Baru <b>{t.newPatients}</b> ·
          Lama <b>{t.returningPatients}</b> · Janji temu tidak datang <b>{t.noShows}</b></p>
      ) : null}
      <Card>
        <CardContent className="pt-6">
          {!data ? <p role="status" className="text-sm text-muted-foreground">Memuat…</p> : data.rows.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada kunjungan pada rentang ini.</p> : (
            <Table>
              <THead><TR><TH>{period === 'month' ? 'Bulan' : 'Tanggal'}</TH>{groupBy !== 'none' ? <TH>{GROUPS.find(([v]) => v === groupBy)?.[1]}</TH> : null}
                <TH className="text-right">Kunjungan</TH><TH className="text-right">Pasien unik</TH><TH className="text-right">Baru</TH><TH className="text-right">Lama</TH>
                <TH className="text-right">Menunggu</TH><TH className="text-right">Dilayani</TH><TH className="text-right">Selesai</TH></TR></THead>
              <TBody>
                {data.rows.map((r) => (
                  <TR key={`${r.period}|${r.groupKey}`} data-testid="report-row">
                    <TD>{r.period}</TD>{groupBy !== 'none' ? <TD>{r.groupLabel}</TD> : null}
                    <TD className="text-right font-medium tabular-nums">{r.visits}</TD><TD className="text-right tabular-nums">{r.uniquePatients}</TD>
                    <TD className="text-right tabular-nums">{r.newPatients}</TD><TD className="text-right tabular-nums">{r.returningPatients}</TD>
                    <TD className="text-right tabular-nums">{r.waiting}</TD><TD className="text-right tabular-nums">{r.inService}</TD><TD className="text-right tabular-nums">{r.finished}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Kunjungan dihitung pada tanggal kedatangan menurut zona waktu cabang; kunjungan batal tidak dihitung. Pasien baru = kunjungan pertama di klinik.
            {data && !data.allBranches ? ' Hanya cabang yang termasuk akses Anda.' : ''}</p>
        </CardContent>
      </Card>
    </div>
  );
}
