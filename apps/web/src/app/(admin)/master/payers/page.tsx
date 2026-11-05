'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Dialog, Field, Input, Select, Switch, TBody, TD, TH, THead, TR, Table, Textarea } from '@clinicrme/ui';
import { Payer, PayerContract, PayerType, api, errorText } from '../../../../lib/api';
import { PAYER_TYPE_LABEL, fmtDate, fmtRupiah } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

/** Penjamin (MST-FR-006): Umum, Asuransi, Perusahaan dengan ketentuan kontrak (dipakai billing Stage 11). */
export default function PayersPage() {
  const s = useSession();
  const manage = can(s, 'master.payer.manage');
  const [items, setItems] = useState<Payer[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [editing, setEditing] = useState<Payer | 'new'>();
  const load = useCallback(async () => {
    try { setItems(await api<Payer[]>('/payers?includeInactive=true')); } catch (e) { setError(errorText(e, 'Gagal memuat penjamin')); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Penjamin</h1>
        {manage ? <Button className="ml-auto" onClick={() => { setNotice(undefined); setEditing('new'); }}>Tambah penjamin</Button> : null}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada penjamin.</p>
          ) : (
            <Table>
              <THead><TR><TH>Kode</TH><TH>Nama</TH><TH>Kategori</TH><TH>Kontrak</TH><TH>Status</TH>{manage ? <TH /> : null}</TR></THead>
              <TBody>
                {items.map((p) => (
                  <TR key={p.id} data-testid="payer-row">
                    <TD className="font-mono text-xs">{p.code}</TD><TD>{p.name}</TD><TD>{PAYER_TYPE_LABEL[p.payerType]}</TD>
                    <TD className="text-xs">{contractSummary(p.contract)}</TD>
                    <TD><Badge tone={p.isActive ? 'success' : 'neutral'}>{p.isActive ? 'Aktif' : 'Nonaktif'}</Badge></TD>
                    {manage ? <TD className="text-right"><Button size="sm" variant="outline" onClick={() => { setNotice(undefined); setEditing(p); }}>Ubah</Button></TD> : null}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {editing ? <PayerDialog item={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)}
        onSaved={async (msg) => { setEditing(undefined); setNotice(msg); setError(undefined); await load(); }} /> : null}
    </div>
  );
}

function contractSummary(c: PayerContract | null) {
  if (!c) return '—';
  return [c.contractNumber && `No. ${c.contractNumber}`, c.plafon && `plafon ${fmtRupiah(c.plafon)}`,
    c.copayPercent !== undefined && `co-pay ${c.copayPercent}%`, c.paymentTermDays !== undefined && `termin ${c.paymentTermDays} hari`,
    c.validUntil && `s.d. ${fmtDate(c.validUntil)}`].filter(Boolean).join(' · ') || '—';
}

function PayerDialog({ item, onClose, onSaved }: { item?: Payer; onClose: () => void; onSaved: (msg: string) => Promise<void> }) {
  const c = item?.contract ?? {};
  const [f, setF] = useState({
    code: item?.code ?? '', name: item?.name ?? '', payerType: (item?.payerType ?? 'ASURANSI') as PayerType, isActive: item?.isActive ?? true,
    contractNumber: c.contractNumber ?? '', validUntil: c.validUntil ?? '', plafon: c.plafon ?? '', copayPercent: c.copayPercent?.toString() ?? '',
    paymentTermDays: c.paymentTermDays?.toString() ?? '', notes: c.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const hasContract = f.payerType === 'ASURANSI' || f.payerType === 'PERUSAHAAN';
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
  const copay = num(f.copayPercent);
  const term = num(f.paymentTermDays);
  const bad = (f.plafon && !/^\d{1,13}$/.test(f.plafon)) || (copay !== undefined && !(copay >= 0 && copay <= 100))
    || (term !== undefined && !(Number.isInteger(term) && term >= 0 && term <= 365));
  const ok = /^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/.test(f.code.trim()) && f.name.trim().length >= 2 && !bad;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError(undefined);
    const contract: PayerContract = {};
    if (hasContract) {
      if (f.contractNumber.trim()) contract.contractNumber = f.contractNumber.trim();
      if (f.validUntil) contract.validUntil = f.validUntil;
      if (f.plafon) contract.plafon = f.plafon;
      if (copay !== undefined) contract.copayPercent = copay;
      if (term !== undefined) contract.paymentTermDays = term;
      if (f.notes.trim()) contract.notes = f.notes.trim();
    }
    const body = { code: f.code.trim(), name: f.name.trim(), payerType: f.payerType, isActive: f.isActive,
      contract: Object.keys(contract).length ? contract : null };
    try {
      await api(item ? `/payers/${item.id}` : '/payers', { method: item ? 'PUT' : 'POST', body, headers: item ? { 'if-match': `"${item.version}"` } : undefined });
      await onSaved(`Penjamin "${body.name}" ${item ? 'disimpan' : 'ditambahkan'}.`);
    } catch (err) { setError(errorText(err, 'Gagal menyimpan penjamin')); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} title={item ? 'Ubah penjamin' : 'Tambah penjamin'} description="Perubahan dicatat di log audit.">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="py-code" label="Kode *"><Input id="py-code" value={f.code} maxLength={20} onChange={(e) => set('code', e.target.value)} /></Field>
          <Field id="py-type" label="Kategori">
            <Select id="py-type" value={f.payerType} onChange={(e) => set('payerType', e.target.value as PayerType)}>
              {Object.entries(PAYER_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
        </div>
        <Field id="py-name" label="Nama *"><Input id="py-name" value={f.name} maxLength={200} onChange={(e) => set('name', e.target.value)} /></Field>
        {hasContract ? (
          <fieldset className="grid gap-3 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Kontrak</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="py-cno" label="Nomor kontrak"><Input id="py-cno" value={f.contractNumber} maxLength={100} onChange={(e) => set('contractNumber', e.target.value)} /></Field>
              <Field id="py-until" label="Berlaku sampai"><Input id="py-until" type="date" value={f.validUntil} onChange={(e) => set('validUntil', e.target.value)} /></Field>
              <Field id="py-plafon" label="Plafon (Rp)"><Input id="py-plafon" inputMode="numeric" value={f.plafon} onChange={(e) => set('plafon', e.target.value.replace(/\D/g, ''))} /></Field>
              <Field id="py-copay" label="Co-pay (%)"><Input id="py-copay" inputMode="decimal" value={f.copayPercent} onChange={(e) => set('copayPercent', e.target.value)} /></Field>
              <Field id="py-term" label="Termin bayar (hari)"><Input id="py-term" inputMode="numeric" value={f.paymentTermDays} onChange={(e) => set('paymentTermDays', e.target.value.replace(/\D/g, ''))} /></Field>
            </div>
            <Field id="py-notes" label="Catatan"><Textarea id="py-notes" value={f.notes} maxLength={1000} onChange={(e) => set('notes', e.target.value)} /></Field>
            {bad ? <p className="text-xs text-destructive" role="alert">Periksa plafon (angka bulat), co-pay (0–100), dan termin (0–365 hari).</p> : null}
          </fieldset>
        ) : null}
        <label className="flex items-center gap-2 text-sm"><Switch checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} aria-label="Aktif" /> Aktif</label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!ok}>Simpan</Button>
        </div>
      </form>
    </Dialog>
  );
}
