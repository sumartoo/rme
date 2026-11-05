'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Dialog, Field, Input, Select, TBody, TD, TH, THead, TR, Table, Textarea } from '@clinicrme/ui';
import { ConsentDocument, api, errorText } from '../../../../lib/api';
import { CONSENT_TYPE_LABEL, fmtDateTime } from '../../../../lib/format';

/**
 * Teks consent berversi (REG-FR-008). Teks yang sudah terbit tidak dapat diubah; perubahan = versi baru, sehingga
 * setiap consent pasien merujuk teks yang benar-benar ditandatangani. Isi wajib ditinjau tenaga medis/hukum klinik.
 */
export default function ConsentDocumentsPage() {
  const [items, setItems] = useState<ConsentDocument[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [open, setOpen] = useState<ConsentDocument | 'new'>();
  const load = useCallback(async () => {
    try { setItems(await api<ConsentDocument[]>('/consent-documents')); setError(undefined); }
    catch (e) { setError(errorText(e, 'Gagal memuat dokumen consent')); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Dokumen consent</h1>
        <Button className="ml-auto" onClick={() => { setNotice(undefined); setOpen('new'); }}>Terbitkan versi baru</Button>
      </div>
      <Alert tone="info">Teks yang sudah terbit tidak dapat diubah. Untuk memperbarui, terbitkan versi baru — consent lama tetap merujuk versi yang ditandatangani.</Alert>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada dokumen consent.</p>
          ) : (
            <Table>
              <THead><TR><TH>Jenis</TH><TH>Versi</TH><TH>Judul</TH><TH>Terbit</TH><TH /></TR></THead>
              <TBody>
                {items.map((d) => (
                  <TR key={d.id} data-testid="consent-doc-row">
                    <TD className="text-xs">{CONSENT_TYPE_LABEL[d.consentType]}</TD>
                    <TD className="text-xs">{d.version}</TD>
                    <TD>{d.title ?? '—'}</TD>
                    <TD className="text-xs">{fmtDateTime(d.effectiveAt)}</TD>
                    <TD className="text-right"><Button size="sm" variant="outline" onClick={() => setOpen(d)}>Lihat / versi baru</Button></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {open ? <ConsentDocDialog base={open === 'new' ? undefined : open} onClose={() => setOpen(undefined)}
        onSaved={async (m) => { setOpen(undefined); await load(); setNotice(m); }} /> : null}
    </div>
  );
}

function ConsentDocDialog({ base, onClose, onSaved }: { base?: ConsentDocument; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [f, setF] = useState({ consentType: base?.consentType ?? 'UMUM', version: '', title: base?.title ?? '', content: base?.content ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const ok = /^[A-Za-z0-9._-]{1,20}$/.test(f.version) && f.title.trim().length >= 3 && f.content.trim().length >= 20;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try { await api('/consent-documents', { method: 'POST', body: { ...f, title: f.title.trim(), content: f.content.trim() } }); await onSaved(`Versi ${f.version} diterbitkan.`); }
    catch (err) { setError(errorText(err, 'Gagal menerbitkan')); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title={base ? `Versi baru — ${CONSENT_TYPE_LABEL[base.consentType]} (sekarang v${base.version})` : 'Terbitkan dokumen consent'} className="max-w-2xl">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="cd-type" label="Jenis">
            <Select id="cd-type" value={f.consentType} disabled={!!base} onChange={(e) => set('consentType', e.target.value as ConsentDocument['consentType'])}>
              {Object.entries(CONSENT_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field id="cd-version" label="Versi *" hint="Mis. 1, 2, 2026.1"><Input id="cd-version" maxLength={20} value={f.version} onChange={(e) => set('version', e.target.value)} /></Field>
        </div>
        <Field id="cd-title" label="Judul *"><Input id="cd-title" maxLength={200} value={f.title} onChange={(e) => set('title', e.target.value)} /></Field>
        <Field id="cd-content" label="Isi *"><Textarea id="cd-content" rows={10} maxLength={20000} value={f.content} onChange={(e) => set('content', e.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!ok}>Terbitkan</Button>
        </div>
      </form>
    </Dialog>
  );
}
