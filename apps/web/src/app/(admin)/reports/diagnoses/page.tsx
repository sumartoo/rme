'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, CardContent, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { api, errorText } from '../../../../lib/api';
import { ReportFilters, defaultFilters, filterQs } from '../report-filters';
import { ExportButton } from '../export-button';

interface DxRow { rank: number; code: string; display: string; cases: number; newCases: number; oldCases: number; patients: number; share: number }
interface DxReport { rows: DxRow[]; totals: { cases: number; encounters: number; signedEncounters: number } }

/** 10 besar diagnosis (RPT-FR-002, OD-125): RM disahkan, diagnosis yang berlaku (setelah addendum), bawaan primer. Agregat tanpa identitas pasien. */
export default function TopDiagnosesPage() {
  const [f, setF] = useState(defaultFilters);
  const [scope, setScope] = useState('primary');
  const [limit, setLimit] = useState('10');
  const [data, setData] = useState<DxReport>();
  const [error, setError] = useState<string>();
  const qs = `${filterQs(f)}&scope=${scope}&limit=${limit}`;
  const load = useCallback(async () => {
    if (!f.from || !f.to) return;
    try { setData(await api<DxReport>(`/reports/top-diagnoses?${qs}`)); setError(undefined); } catch (e) { setError(errorText(e, 'Gagal memuat laporan')); }
  }, [qs, f.from, f.to]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">10 besar diagnosis</h1>
        <ExportButton code="top-diagnoses" params={Object.fromEntries(new URLSearchParams(qs))} csvHref={`/api/v1/reports/top-diagnoses?${qs}&format=csv`} />
      </div>
      <ReportFilters value={f} onChange={setF}>
        <label className="grid gap-1 text-xs">Diagnosis
          <Select aria-label="Jenis diagnosis" value={scope} onChange={(e) => setScope(e.target.value)}><option value="primary">Primer</option><option value="all">Primer & sekunder</option></Select>
        </label>
        <label className="grid gap-1 text-xs">Jumlah
          <Select aria-label="Jumlah baris" value={limit} onChange={(e) => setLimit(e.target.value)}><option value="10">10 besar</option><option value="20">20 besar</option><option value="50">50 besar</option></Select>
        </label>
      </ReportFilters>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {data ? <p className="text-sm" data-testid="report-totals">Kasus <b>{data.totals.cases}</b> dari <b>{data.totals.signedEncounters}</b> kunjungan dengan RM disahkan</p> : null}
      <Card>
        <CardContent className="pt-6">
          {!data ? <p role="status" className="text-sm text-muted-foreground">Memuat…</p> : data.rows.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada diagnosis pada rentang ini.</p> : (
            <Table>
              <THead><TR><TH>No</TH><TH>Kode</TH><TH>Diagnosis</TH><TH className="text-right">Kasus</TH><TH className="text-right">Baru</TH><TH className="text-right">Lama</TH>
                <TH className="text-right">Pasien</TH><TH className="text-right">%</TH></TR></THead>
              <TBody>
                {data.rows.map((r) => (
                  <TR key={r.code} data-testid="report-row">
                    <TD>{r.rank}</TD><TD className="font-mono">{r.code}</TD><TD>{r.display}</TD><TD className="text-right font-medium tabular-nums">{r.cases}</TD>
                    <TD className="text-right tabular-nums">{r.newCases}</TD><TD className="text-right tabular-nums">{r.oldCases}</TD><TD className="text-right tabular-nums">{r.patients}</TD>
                    <TD className="text-right tabular-nums">{r.share.toLocaleString('id-ID')}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Hanya kunjungan dengan rekam medis disahkan; diagnosis yang berlaku setelah addendum. Tanggal = tanggal kedatangan.</p>
        </CardContent>
      </Card>
    </div>
  );
}
