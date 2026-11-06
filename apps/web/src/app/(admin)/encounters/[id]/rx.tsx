'use client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Textarea } from '@clinicrme/ui';
import { ApiError, Drug, EncounterChart, Page, Prescription, RxAlert, RxRoute, Uom, api, errorText } from '../../../../lib/api';
import { fmtDateTime } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

const ROUTE_LABEL: Record<RxRoute, string> = {
  ORAL: 'Oral', SUBLINGUAL: 'Sublingual', TOPIKAL: 'Topikal', TETES_MATA: 'Tetes mata', TETES_TELINGA: 'Tetes telinga', INHALASI: 'Inhalasi',
  REKTAL: 'Rektal', INJEKSI: 'Injeksi', LAINNYA: 'Lainnya',
};
const ALERT_LABEL: Record<RxAlert['type'], string> = { ALLERGY: 'Alergi', DUPLICATE: 'Duplikasi', DOSE_MAX: 'Dosis', DAILY_MAX: 'Dosis harian' };
type DrugRef = { id: string; name: string; uomName: string };
type Line = {
  kind: 'DRUG' | 'COMPOUND'; drug?: DrugRef; compoundName: string; compoundForm: string; uomId: string; components: { drug?: DrugRef; qty: string }[];
  doseQty: string; timesPerDay: string; route: RxRoute; durationDays: string; qty: string; qtyTouched: boolean; instructions: string;
};
const blank = (kind: Line['kind']): Line => ({ kind, compoundName: '', compoundForm: 'Puyer', uomId: '', components: [{ qty: '' }, { qty: '' }],
  doseQty: '1', timesPerDay: '3', route: 'ORAL', durationDays: '3', qty: '9', qtyTouched: false, instructions: '' });
const n = (s: string) => Number(s.replace(',', '.'));
const autoQty = (l: Line) => (l.qtyTouched ? l.qty : (n(l.doseQty) * n(l.timesPerDay) * (n(l.durationDays) || 1) || '').toString());

function fromRx(p: Prescription | null): Line[] {
  return (p?.items ?? []).map((i) => ({
    kind: i.kind, drug: i.drugItemId ? { id: i.drugItemId, name: i.drugName ?? '', uomName: i.uomName } : undefined,
    compoundName: i.compoundName ?? '', compoundForm: i.compoundForm ?? '', uomId: i.kind === 'COMPOUND' ? i.uomId : '',
    components: i.components.map((c) => ({ drug: { id: c.drugItemId, name: c.drugName, uomName: c.uomName }, qty: String(c.qty) })),
    doseQty: String(i.doseQty ?? 1), timesPerDay: String(i.timesPerDay ?? 1), route: i.route, durationDays: i.durationDays ? String(i.durationDays) : '',
    qty: String(i.qty), qtyTouched: true, instructions: i.instructions ?? '',
  }));
}

function DrugPick({ value, label, onPick }: { value?: DrugRef; label: string; onPick: (d: DrugRef) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Drug[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setItems([]); return; }
    const t = setTimeout(() => { void api<Page<Drug>>(`/drugs?${new URLSearchParams({ q: q.trim(), limit: '10' })}`).then((r) => setItems(r.data)).catch(() => setItems([])); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  if (value) return <div className="flex items-center gap-2 text-sm"><b>{value.name}</b><Button size="sm" variant="ghost" onClick={() => onPick(undefined as unknown as DrugRef)}>Ganti</Button></div>;
  return (
    <div className="grid gap-1">
      <Input aria-label={label} placeholder={`${label} — nama atau zat aktif`} value={q} onChange={(e) => setQ(e.target.value)} />
      {items.length ? (
        <ul className="max-h-48 overflow-auto rounded-md border text-sm">
          {items.map((d) => (
            <li key={d.id}><button type="button" className="w-full px-3 py-1.5 text-left hover:bg-muted"
              onClick={() => { onPick({ id: d.id, name: d.genericName, uomName: d.uomName }); setQ(''); setItems([]); }}>
              {d.genericName}{d.brandName ? ` (${d.brandName})` : ''} <span className="text-xs text-muted-foreground">· {d.ingredients.join(', ')} · {d.uomName}</span>
            </button></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Resep elektronik (CLN-FR-010–012): non-racikan & racikan, disimpan sebagai draft selama pasien diperiksa. Peringatan
 * alergi, duplikasi zat aktif, dan batas dosis muncul setiap simpan; dokter boleh melanjutkan dengan alasan (OD-033).
 * Resep diterbitkan saat "Selesai konsultasi".
 */
export function RxTab({ chart, onSaved }: { chart: EncounterChart; onSaved: () => Promise<void> }) {
  const s = useSession();
  const rx = chart.prescription;
  const editable = can(s, 'clinical.prescription.write') && chart.encounter.status === 'IN_CONSULTATION' && (!rx || rx.status === 'DRAFT');
  const [lines, setLines] = useState<Line[]>(() => fromRx(rx));
  const [reasons, setReasons] = useState<Record<string, string>>(() => Object.fromEntries((rx?.alerts ?? []).filter((a) => a.reason).map((a) => [a.key, a.reason!])));
  const [notes, setNotes] = useState(rx?.notes ?? '');
  const [uoms, setUoms] = useState<Uom[]>([]);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (editable) void api<Uom[]>('/uoms').then(setUoms).catch(() => undefined); }, [editable]);
  const upd = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  async function save() {
    setBusy(true); setSaved(undefined);
    try {
      const items = lines.map((l) => ({
        kind: l.kind, ...(l.kind === 'DRUG' ? { drugItemId: l.drug?.id } : { compoundName: l.compoundName.trim(), compoundForm: l.compoundForm.trim(), uomId: l.uomId,
          components: l.components.filter((c) => c.drug).map((c) => ({ drugItemId: c.drug!.id, qty: n(c.qty) })) }),
        doseQty: n(l.doseQty), timesPerDay: n(l.timesPerDay), route: l.route, durationDays: l.durationDays ? n(l.durationDays) : null,
        qty: n(autoQty(l)), instructions: l.instructions.trim() || null,
      }));
      const overrides = Object.entries(reasons).filter(([, r]) => r.trim().length >= 5).map(([key, reason]) => ({ key, reason: reason.trim() }));
      await api(`/encounters/${chart.encounter.id}/prescription`, { method: 'PUT', body: { items, overrides, notes: notes.trim() || null } });
      setError(undefined); setSaved('Resep tersimpan sebagai draft.'); await onSaved();
    } catch (e) {
      setError(e instanceof ApiError && e.problem.errors?.length ? e.problem.errors.map((x) => `${x.field}: ${x.message}`).join('; ') : errorText(e, 'Gagal menyimpan resep'));
    } finally { setBusy(false); }
  }

  if (!editable) {
    return (
      <Card>
        <CardHeader><CardTitle className="flex flex-wrap items-center gap-2">Resep {rx ? <span className="font-mono text-sm">{rx.prescriptionNo}</span> : null}
          {rx ? <Badge tone={rx.status === 'DRAFT' ? 'neutral' : 'success'}>{rx.status === 'DRAFT' ? 'Draft' : 'Diterbitkan'}</Badge> : null}</CardTitle></CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {!rx || rx.items.length === 0 ? <p className="text-muted-foreground">Tidak ada resep.</p> : rx.items.map((i) => (
            <p key={i.id} data-testid="rx-line"><b>{i.lineNo}. {i.kind === 'DRUG' ? i.drugName : `${i.compoundName} (racikan)`}</b> — {i.doseQty} {i.uomName} {i.frequency}, {ROUTE_LABEL[i.route]}, jumlah {i.qty} {i.uomName}
              {i.components.length ? ` · ${i.components.map((c) => `${c.drugName} ${c.qty} ${c.uomName}`).join(', ')}` : ''}{i.instructions ? ` · ${i.instructions}` : ''}</p>
          ))}
          {rx?.issuedAt ? <p className="text-xs text-muted-foreground">Diterbitkan {fmtDateTime(rx.issuedAt)} oleh {rx.prescriberName}</p> : null}
          {rx?.alerts.length ? <ul className="text-xs text-amber-800">{rx.alerts.map((a) => <li key={a.key}>⚠ {a.message}{a.reason ? ` — alasan: ${a.reason}` : ''}</li>)}</ul> : null}
        </CardContent>
      </Card>
    );
  }
  const alerts = rx?.alerts ?? [];
  return (
    <Card>
      <CardHeader><CardTitle className="flex flex-wrap items-center gap-2">Resep {rx ? <span className="font-mono text-sm">{rx.prescriptionNo}</span> : null} <Badge tone="neutral">Draft</Badge></CardTitle></CardHeader>
      <CardContent className="grid gap-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {saved ? <Alert tone="success" data-testid="rx-saved">{saved}</Alert> : null}
        {lines.map((l, i) => (
          <div key={i} className="grid gap-3 rounded-md border p-3" data-testid="rx-edit-line">
            <div className="flex items-center gap-2 text-sm font-medium">{i + 1}. {l.kind === 'DRUG' ? 'Obat' : 'Racikan'}
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}>Hapus baris</Button></div>
            {l.kind === 'DRUG' ? <DrugPick value={l.drug} label={`Cari obat baris ${i + 1}`} onPick={(d) => upd(i, { drug: d })} /> : (
              <div className="grid gap-2 sm:grid-cols-3">
                <Field id={`cn-${i}`} label="Nama racikan"><Input id={`cn-${i}`} value={l.compoundName} onChange={(e) => upd(i, { compoundName: e.target.value })} /></Field>
                <Field id={`cf-${i}`} label="Bentuk"><Input id={`cf-${i}`} value={l.compoundForm} onChange={(e) => upd(i, { compoundForm: e.target.value })} /></Field>
                <Field id={`cu-${i}`} label="Satuan racikan">
                  <Select id={`cu-${i}`} value={l.uomId} onChange={(e) => upd(i, { uomId: e.target.value })}>
                    <option value="">— pilih —</option>{uoms.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </Select>
                </Field>
                <div className="grid gap-2 sm:col-span-3">
                  {l.components.map((c, k) => (
                    <div key={k} className="grid items-end gap-2 sm:grid-cols-[1fr_8rem_auto]">
                      <DrugPick value={c.drug} label={`Komponen ${k + 1} baris ${i + 1}`} onPick={(d) => upd(i, { components: l.components.map((x, j) => (j === k ? { ...x, drug: d } : x)) })} />
                      <Field id={`cq-${i}-${k}`} label={`Jumlah${c.drug ? ` (${c.drug.uomName})` : ''}`}><Input id={`cq-${i}-${k}`} inputMode="decimal" value={c.qty}
                        onChange={(e) => upd(i, { components: l.components.map((x, j) => (j === k ? { ...x, qty: e.target.value } : x)) })} /></Field>
                      <Button size="sm" variant="ghost" onClick={() => upd(i, { components: l.components.filter((_, j) => j !== k) })}>×</Button>
                    </div>
                  ))}
                  <Button size="sm" variant="outline" className="justify-self-start" onClick={() => upd(i, { components: [...l.components, { qty: '' }] })}>Tambah komponen</Button>
                </div>
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-6">
              <Field id={`dq-${i}`} label={`Dosis${l.kind === 'DRUG' && l.drug ? ` (${l.drug.uomName})` : ''}`}><Input id={`dq-${i}`} inputMode="decimal" value={l.doseQty} onChange={(e) => upd(i, { doseQty: e.target.value })} /></Field>
              <Field id={`tp-${i}`} label="Kali/hari"><Input id={`tp-${i}`} inputMode="numeric" value={l.timesPerDay} onChange={(e) => upd(i, { timesPerDay: e.target.value })} /></Field>
              <Field id={`dd-${i}`} label="Hari"><Input id={`dd-${i}`} inputMode="numeric" value={l.durationDays} onChange={(e) => upd(i, { durationDays: e.target.value })} /></Field>
              <Field id={`qt-${i}`} label="Jumlah"><Input id={`qt-${i}`} inputMode="decimal" value={autoQty(l)} onChange={(e) => upd(i, { qty: e.target.value, qtyTouched: true })} /></Field>
              <Field id={`rt-${i}`} label="Rute">
                <Select id={`rt-${i}`} value={l.route} onChange={(e) => upd(i, { route: e.target.value as RxRoute })}>
                  {Object.entries(ROUTE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <Field id={`in-${i}`} label="Aturan pakai"><Input id={`in-${i}`} maxLength={500} value={l.instructions} onChange={(e) => upd(i, { instructions: e.target.value })} /></Field>
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setLines((ls) => [...ls, blank('DRUG')])}>Tambah obat</Button>
          <Button variant="outline" onClick={() => setLines((ls) => [...ls, blank('COMPOUND')])}>Tambah racikan</Button>
        </div>
        <Field id="rx-notes" label="Catatan untuk farmasi"><Textarea id="rx-notes" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {alerts.length ? (
          <div className="grid gap-2 rounded-md border border-amber-400 bg-amber-50 p-3" data-testid="rx-alerts">
            <p className="text-sm font-medium">Peringatan — isi alasan bila tetap dilanjutkan (wajib sebelum resep diterbitkan). Sistem bukan pengganti penilaian klinis.</p>
            {alerts.map((a) => (
              <div key={a.key} className="grid gap-1" data-testid="rx-alert">
                <p className="text-sm"><Badge tone="warning">{ALERT_LABEL[a.type]}</Badge> {a.message}</p>
                <Input aria-label={`Alasan ${a.key}`} placeholder="Alasan melanjutkan (min. 5 huruf)" maxLength={500} value={reasons[a.key] ?? ''}
                       onChange={(e) => setReasons((r) => ({ ...r, [a.key]: e.target.value }))} />
              </div>
            ))}
          </div>
        ) : null}
        <Button className="justify-self-start" loading={busy} onClick={() => void save()}>Simpan resep</Button>
      </CardContent>
    </Card>
  );
}
