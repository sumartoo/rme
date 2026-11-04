'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { ExportJob, api, errorText } from '../../../../lib/api';
import { EXPORT_LABEL, EXPORT_TONE, fmtBytes, fmtDateTime } from '../../../../lib/format';

const busyStatus = (j: ExportJob) => j.status === 'QUEUED' || j.status === 'RUNNING';

/**
 * PLT-FR-008: ekspor seluruh data klinik. Arsip terenkripsi (AES-256-GCM) dan kuncinya diambil terpisah;
 * keduanya tercatat di log audit klinik. Tautan berlaku terbatas (EXPORT_TTL_HOURS).
 */
export default function ExportsPage() {
  const [jobs, setJobs] = useState<ExportJob[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<{ job: ExportJob; key: string }>();

  const load = useCallback(() => api<ExportJob[]>('/tenant/exports').then(setJobs).catch((e) => setError(errorText(e, 'Gagal memuat ekspor'))), []);
  useEffect(() => { void load(); }, [load]);
  // Selama ada ekspor yang diproses, cek ulang tiap 3 detik
  useEffect(() => {
    if (!jobs?.some(busyStatus)) return;
    const t = setTimeout(() => { void load(); }, 3000);
    return () => clearTimeout(t);
  }, [jobs, load]);

  async function request() {
    setBusy(true); setError(undefined);
    try { await api('/tenant/exports', { method: 'POST' }); await load(); }
    catch (e) { setError(errorText(e, 'Gagal meminta ekspor')); }
    finally { setBusy(false); }
  }

  async function showKey(job: ExportJob) {
    setError(undefined);
    try { setKey({ job, key: (await api<{ key: string }>(`/tenant/exports/${job.id}/key`)).key }); }
    catch (e) { setError(errorText(e, 'Gagal mengambil kunci')); }
  }

  const active = jobs?.some(busyStatus);
  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Ekspor data klinik</h1>
      <Card>
        <CardHeader>
          <CardTitle>Salinan seluruh data</CardTitle>
          <CardDescription>
            Berisi semua data klinik (pasien, kunjungan, rekam medis, transaksi) dalam satu arsip terenkripsi. Unduh arsip dan ambil kuncinya,
            lalu buka dengan alat <code>decrypt-export</code>. Tautan unduh berlaku terbatas; setiap unduhan dan pengambilan kunci tercatat di log audit.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button onClick={request} loading={busy} disabled={active} className="justify-self-start">Minta ekspor baru</Button>
          {active ? <p className="text-sm text-muted-foreground" role="status">Ekspor sedang diproses. Halaman ini diperbarui otomatis.</p> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Riwayat</CardTitle></CardHeader>
        <CardContent>
          {!jobs ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada ekspor.</p>
          ) : (
            <Table>
              <THead><TR><TH>Diminta</TH><TH>Status</TH><TH>Isi</TH><TH>Berlaku sampai</TH><TH className="text-right">Aksi</TH></TR></THead>
              <TBody>
                {jobs.map((j) => (
                  <TR key={j.id} data-testid="export-row">
                    <TD className="whitespace-nowrap">{fmtDateTime(j.requestedAt)}</TD>
                    <TD><Badge tone={EXPORT_TONE[j.status]} data-testid="export-status">{EXPORT_LABEL[j.status]}</Badge>
                      {j.error ? <span className="block text-xs text-destructive">{j.error}</span> : null}</TD>
                    <TD className="text-xs">{j.status === 'DONE' ? `${j.tableCount} tabel · ${j.rowCount} baris · ${fmtBytes(j.sizeBytes)}` : '—'}</TD>
                    <TD className="whitespace-nowrap text-xs">{fmtDateTime(j.expiresAt)}</TD>
                    <TD className="text-right">
                      {j.status === 'DONE' && j.downloadUrl ? (
                        <span className="inline-flex gap-2">
                          <a href={j.downloadUrl} download className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted">Unduh arsip</a>
                          <Button size="sm" variant="outline" onClick={() => showKey(j)}>Tampilkan kunci</Button>
                        </span>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Dialog open={!!key} onClose={() => setKey(undefined)} title="Kunci dekripsi" description={key ? `Ekspor ${fmtDateTime(key.job.requestedAt)}` : ''}>
        {key ? <>
          <Alert tone="info">Simpan kunci terpisah dari arsip. Siapa pun yang memegang arsip dan kunci dapat membaca seluruh data klinik.</Alert>
          <code data-testid="export-key" className="block break-all rounded bg-muted px-2 py-1 font-mono text-sm">{key.key}</code>
          {key.job.sha256 ? <p className="text-xs text-muted-foreground">SHA-256 arsip: <span className="break-all font-mono">{key.job.sha256}</span></p> : null}
          <p className="text-xs text-muted-foreground">Buka arsip: <code>node tools/export/decrypt-export.mjs &lt;arsip.crmex&gt; &lt;kunci&gt; &lt;folder&gt;</code></p>
          <div className="flex justify-end"><Button variant="outline" onClick={() => setKey(undefined)}>Tutup</Button></div>
        </> : null}
      </Dialog>
    </div>
  );
}
