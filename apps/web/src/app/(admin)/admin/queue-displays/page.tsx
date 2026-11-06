'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Dialog, Field, Input, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { BranchItem, api, errorText } from '../../../../lib/api';
import { fmtDateTime } from '../../../../lib/format';

interface DisplayLink { id: string; branchId: string; branchName: string; label: string; createdAt: string; revokedAt: string | null; lastSeenAt: string | null; token?: string; path?: string }

/**
 * Tautan layar TV antrean per cabang (OD-088). TV tidak login: cukup buka tautan di peramban TV. Tautan hanya
 * ditampilkan sekali saat dibuat; bila hilang atau bocor, cabut lalu buat tautan baru. Layar tidak menampilkan nama
 * pasien (inisial dapat diaktifkan di Profil klinik).
 */
export default function QueueDisplaysPage() {
  const [items, setItems] = useState<DisplayLink[]>();
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<DisplayLink>();
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    try { setItems(await api<DisplayLink[]>('/queue-displays')); setError(undefined); }
    catch (e) { setError(errorText(e, 'Gagal memuat layar antrean')); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function revoke(l: DisplayLink) {
    try { await api(`/queue-displays/${l.id}/revoke`, { method: 'POST' }); setCreated(undefined); await load(); }
    catch (e) { setError(errorText(e, 'Gagal mencabut')); }
  }
  const url = created?.path ? `${window.location.origin}${created.path}` : '';
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Layar antrean</h1>
        <Button className="ml-auto" onClick={() => { setCreated(undefined); setOpen(true); }}>Buat tautan layar</Button>
      </div>
      {created ? (
        <Alert tone="success" data-testid="display-url">
          Tautan untuk <b>{created.label}</b> — buka di peramban TV. Tautan ini hanya ditampilkan sekali; simpan sekarang.
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-card px-2 py-1 text-xs">{url}</code>
            <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(url)}>Salin</Button>
            <a className="text-sm font-medium underline" href={created.path} target="_blank" rel="noreferrer">Buka</a>
          </div>
        </Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada tautan layar.</p>
          ) : (
            <Table>
              <THead><TR><TH>Label</TH><TH>Cabang</TH><TH>Dibuat</TH><TH>Terakhir dibuka</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {items.map((l) => (
                  <TR key={l.id} data-testid="display-row">
                    <TD className="font-medium">{l.label}</TD>
                    <TD className="text-xs">{l.branchName}</TD>
                    <TD className="text-xs">{fmtDateTime(l.createdAt)}</TD>
                    <TD className="text-xs">{l.lastSeenAt ? fmtDateTime(l.lastSeenAt) : '—'}</TD>
                    <TD><Badge tone={l.revokedAt ? 'neutral' : 'success'}>{l.revokedAt ? 'Dicabut' : 'Aktif'}</Badge></TD>
                    <TD className="text-right">{l.revokedAt ? null : <Button size="sm" variant="ghost" onClick={() => void revoke(l)}>Cabut</Button>}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {open ? <CreateDialog onClose={() => setOpen(false)} onCreated={async (l) => { setOpen(false); setCreated(l); await load(); }} /> : null}
    </div>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (l: DisplayLink) => Promise<void> }) {
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [branchId, setBranchId] = useState('');
  const [label, setLabel] = useState('TV ruang tunggu');
  const [error, setError] = useState<string>();
  useEffect(() => { void api<BranchItem[]>('/branches').then((b) => { const a = b.filter((x) => x.isActive); setBranches(a); setBranchId(a[0]?.id ?? ''); }).catch(() => undefined); }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try { await onCreated(await api<DisplayLink>('/queue-displays', { method: 'POST', body: { branchId, label: label.trim() } })); }
    catch (err) { setError(errorText(err, 'Gagal membuat tautan')); }
  }
  return (
    <Dialog open onClose={onClose} title="Buat tautan layar">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="qd-branch" label="Cabang">
          <Select id="qd-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field id="qd-label" label="Label"><Input id="qd-label" maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" disabled={!branchId || label.trim().length < 2}>Buat tautan</Button>
        </div>
      </form>
    </Dialog>
  );
}
