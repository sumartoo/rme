'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, Select } from '@clinicrme/ui';
import { api, errorText } from '../../../lib/api';
import { can, useSession } from '../../../lib/session';

interface ExportJob { id: string; status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'EXPIRED'; rowCount: number | null; downloadUrl: string | null; error: string | null }
const FORMATS: [string, string][] = [['XLSX', 'Excel (.xlsx)'], ['CSV', 'CSV'], ['PDF', 'PDF']];

/**
 * Ekspor laporan seragam (RPT-FR-008, OD-128): Excel/CSV/PDF dengan watermark (nama klinik, pengekspor, waktu, "Rahasia — untuk internal klinik").
 * ≤ 10.000 baris langsung terunduh; di atasnya diproses di latar belakang dan tautan unduh muncul saat selesai (berlaku 24 jam).
 * Tanpa izin `report.export` tidak ada unduhan sama sekali, termasuk tautan CSV cepat (OD-132 / DEC-048).
 */
export function ExportButton({ code, params, csvHref, csvLabel = 'Unduh CSV', csvTestId = 'report-csv' }: {
  code: string; params: Record<string, string | undefined>; csvHref?: string; csvLabel?: string; csvTestId?: string;
}) {
  const s = useSession();
  const [format, setFormat] = useState('XLSX');
  const [job, setJob] = useState<ExportJob>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const allowed = can(s, 'report.export');

  const poll = (id: string) => {
    timer.current = setTimeout(async () => {
      try {
        const j = await api<ExportJob>(`/report-exports/${id}`);
        setJob(j);
        if (j.status === 'QUEUED' || j.status === 'RUNNING') poll(id);
        else if (j.status === 'DONE' && j.downloadUrl) window.location.assign(j.downloadUrl);
      } catch (e) { setError(errorText(e, 'Gagal memeriksa status ekspor')); }
    }, 3000);
  };
  const start = async () => {
    clearTimeout(timer.current);
    setBusy(true); setError(undefined); setJob(undefined);
    try {
      const parameters = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
      const j = await api<ExportJob>(`/reports/${code}/exports`, { method: 'POST', body: { format, parameters } });
      setJob(j);
      if (j.status === 'DONE' && j.downloadUrl) window.location.assign(j.downloadUrl);
      else if (j.status === 'QUEUED' || j.status === 'RUNNING') poll(j.id);
    } catch (e) { setError(errorText(e, 'Ekspor gagal')); } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="report-export">
      {csvHref && allowed ? <a className="underline" href={csvHref} data-testid={csvTestId}>{csvLabel}</a> : null}
      {allowed ? (
        <>
          <Select aria-label="Format ekspor" className="w-36" value={format} onChange={(e) => setFormat(e.target.value)}>
            {FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
          <Button size="sm" variant="outline" onClick={start} disabled={busy}>{busy ? 'Menyiapkan…' : 'Ekspor'}</Button>
        </>
      ) : null}
      <span role="status" className="text-xs text-muted-foreground" data-testid="export-status">
        {job?.status === 'QUEUED' || job?.status === 'RUNNING' ? `Data besar (${job.rowCount ?? 'lebih dari 10.000'} baris) sedang diproses — tautan muncul di sini.` : null}
        {job?.status === 'DONE' && job.downloadUrl ? <>Ekspor siap ({job.rowCount} baris). <a className="underline" href={job.downloadUrl}>Unduh lagi</a> (berlaku 24 jam).</> : null}
        {job?.status === 'FAILED' ? <span className="text-destructive">Ekspor gagal: {job.error}</span> : null}
        {job?.status === 'EXPIRED' ? 'Tautan kedaluwarsa. Ekspor ulang.' : null}
      </span>
      {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
