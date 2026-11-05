'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { ImportResult, apiUpload, errorText } from '../../../../lib/api';
import { can, useSession } from '../../../../lib/session';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ENTITIES: { id: string; label: string; manage: string; hint: string }[] = [
  { id: 'service-items', label: 'Layanan', manage: 'master.service.manage', hint: 'Kunci: code. Baris dengan kode yang sudah ada = diubah.' },
  { id: 'tariffs', label: 'Tarif', manage: 'master.tariff.manage', hint: 'Hanya menambah periode baru (tarif tidak pernah ditimpa). closePrevious=ya menutup periode berjalan.' },
  { id: 'payers', label: 'Penjamin', manage: 'master.payer.manage', hint: 'Kunci: code. Kolom kontrak opsional.' },
  { id: 'practitioners', label: 'Tenaga kesehatan', manage: 'master.practitioner.manage', hint: 'Kunci: id (kosong = data baru). NIK tidak pernah diekspor; NIK kosong saat impor = tetap.' },
  { id: 'service-units', label: 'Poli/unit', manage: 'master.facility.manage', hint: 'Kunci: branchCode + code.' },
  { id: 'uoms', label: 'Satuan', manage: 'master.uom.manage', hint: 'Kunci: code. Konversi diatur di halaman Satuan & supplier.' },
  { id: 'suppliers', label: 'Supplier', manage: 'master.supplier.manage', hint: 'Kunci: code (kosong = supplier baru).' },
];

/**
 * Impor & ekspor master data (MST-FR-008): unduh template/ekspor (CSV atau Excel) → isi → unggah → periksa (dry-run,
 * tidak menyimpan) → simpan. Penyimpanan hanya bila semua baris valid, dalam satu transaksi.
 */
export default function TransferPage() {
  const s = useSession();
  const [entity, setEntity] = useState(ENTITIES[0].id);
  const [file, setFile] = useState<File>();
  const [result, setResult] = useState<ImportResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const spec = ENTITIES.find((e) => e.id === entity)!;
  const canImport = can(s, 'master.import') && can(s, spec.manage);
  const canExport = can(s, 'master.export');

  async function run(dryRun: boolean) {
    if (!file) return;
    setBusy(true); setError(undefined);
    const type = file.name.toLowerCase().endsWith('.xlsx') ? XLSX : 'text/csv';
    try { setResult(await apiUpload<ImportResult>(`/imports/${entity}?dryRun=${dryRun}`, file, type)); }
    catch (e) { setResult(undefined); setError(errorText(e, 'Impor gagal')); }
    finally { setBusy(false); }
  }

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Impor & ekspor</h1>
      <Card>
        <CardHeader><CardTitle>Jenis data</CardTitle><CardDescription>{spec.hint}</CardDescription></CardHeader>
        <CardContent className="grid gap-4">
          <Field id="tr-entity" label="Jenis data">
            <Select id="tr-entity" className="w-64" value={entity} onChange={(e) => { setEntity(e.target.value); setResult(undefined); setError(undefined); }}>
              {ENTITIES.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </Select>
          </Field>
          {canExport ? (
            <div className="flex flex-wrap gap-2 text-sm">
              <a className="underline" href={`/api/v1/exports/${entity}?template=true&format=xlsx`}>Template Excel</a>
              <a className="underline" href={`/api/v1/exports/${entity}?template=true&format=csv`}>Template CSV</a>
              <span className="text-muted-foreground">·</span>
              <a className="underline" href={`/api/v1/exports/${entity}?format=xlsx`}>Ekspor Excel</a>
              <a className="underline" href={`/api/v1/exports/${entity}?format=csv`}>Ekspor CSV</a>
            </div>
          ) : null}
        </CardContent>
      </Card>
      {canImport ? (
        <Card>
          <CardHeader>
            <CardTitle>Impor {spec.label}</CardTitle>
            <CardDescription>CSV (koma atau titik koma) atau Excel .xlsx, maks 5.000 baris / 5 MB. Periksa dulu; data baru tersimpan setelah Anda menekan Simpan.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <input aria-label="Berkas impor" type="file" accept=".csv,.xlsx,text/csv" className="text-sm"
                   onChange={(e) => { setFile(e.target.files?.[0]); setResult(undefined); setError(undefined); }} />
            <div className="flex gap-2">
              <Button variant="outline" loading={busy && !result} disabled={!file || busy} onClick={() => run(true)}>Periksa</Button>
              <Button disabled={!file || busy || result?.status !== 'VALIDATED'} loading={busy && !!result} onClick={() => run(false)}>Simpan</Button>
            </div>
            {error ? <Alert tone="error">{error}</Alert> : null}
            {result ? (
              <div className="grid gap-2" data-testid="import-result">
                <p className="text-sm">
                  <Badge tone={result.status === 'FAILED' ? 'danger' : result.status === 'COMMITTED' ? 'success' : 'info'}>
                    {result.status === 'FAILED' ? 'Ada kesalahan' : result.status === 'COMMITTED' ? 'Tersimpan' : 'Siap disimpan'}
                  </Badge>{' '}
                  {result.rowCount} baris · {result.created} baru · {result.updated} diubah
                  {result.status === 'FAILED' ? ' · tidak ada yang disimpan' : ''}
                </p>
                {result.errors.length ? (
                  <Table>
                    <THead><TR><TH>Baris</TH><TH>Kolom</TH><TH>Kesalahan</TH></TR></THead>
                    <TBody>
                      {result.errors.map((e, i) => (
                        <TR key={i} data-testid="import-error"><TD>{e.row}</TD><TD className="font-mono text-xs">{e.field || '—'}</TD><TD>{e.message}</TD></TR>
                      ))}
                    </TBody>
                  </Table>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : <Alert tone="info">Anda tidak memiliki izin mengimpor {spec.label.toLowerCase()}.</Alert>}
    </div>
  );
}
