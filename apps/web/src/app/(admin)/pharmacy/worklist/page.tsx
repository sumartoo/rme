'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Dialog, Field, Input, Select, TBody, TD, TH, THead, TR, Table, Textarea } from '@clinicrme/ui';
import { ApiError, DispenseResult, Drug, PharmacyPrescription, PharmacyWorkItem, RxPharmacyItem, RxStatus, api, errorText } from '../../../../lib/api';
import { PAYER_TYPE_LABEL, fmtDate, fmtDateTime, fmtRupiah } from '../../../../lib/format';
import { useSession } from '../../../../lib/session';
import { DrugPicker } from '../drug-picker';

type Tab = 'PENDING' | 'PARTIAL' | 'DONE';
const TAB_LABEL: Record<Tab, string> = { PENDING: 'Menunggu', PARTIAL: 'Sisa belum diambil', DONE: 'Selesai hari ini' };
const STATUS_LABEL: Record<RxStatus, string> = {
  ISSUED: 'Perlu telaah', VERIFIED: 'Siap diserahkan', PARTIALLY_DISPENSED: 'Sebagian diserahkan', DISPENSED: 'Selesai', CLOSED: 'Ditutup',
};
const STATUS_TONE: Record<RxStatus, 'warning' | 'success' | 'neutral' | 'danger'> = {
  ISSUED: 'warning', VERIFIED: 'success', PARTIALLY_DISPENSED: 'warning', DISPENSED: 'neutral', CLOSED: 'neutral',
};
const GROUP_LABEL = { ADMINISTRATIF: 'Administratif', FARMASETIK: 'Farmasetik', KLINIS: 'Klinis' } as const;
const qty = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 4 });
const itemName = (i: RxPharmacyItem) => (i.kind === 'COMPOUND' ? `${i.compoundName} (${i.compoundForm})` : `${i.drugName}${i.strength ? ` ${i.strength}` : ''}`);

/**
 * Resep masuk farmasi (PHM-FR-005–009, 011, 013): worklist per cabang aktif → telaah checklist (OD-098) → penyerahan
 * dengan batch FEFO/FIFO otomatis, sebagian bila stok kurang, etiket 80×50 mm, dan tutup sisa resep (OD-104).
 */
export default function PharmacyWorklistPage() {
  const s = useSession();
  const branchId = s.me.activeBranchId ?? '';
  const [tab, setTab] = useState<Tab>('PENDING');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PharmacyWorkItem[]>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ status: tab });
      if (branchId) p.set('branchId', branchId);
      if (q.trim()) p.set('q', q.trim());
      setItems(await api<PharmacyWorkItem[]>(`/pharmacy/worklist?${p}`)); setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal memuat resep')); }
  }, [tab, branchId, q]);
  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [load]);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Resep masuk</h1>
        <div className="flex gap-1" role="tablist">
          {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
            <Button key={t} role="tab" aria-selected={tab === t} size="sm" variant={tab === t ? 'default' : 'outline'} onClick={() => setTab(t)}>{TAB_LABEL[t]}</Button>
          ))}
        </div>
        <Input aria-label="Cari resep" placeholder="Nama pasien, No. RM, No. resep" className="w-64" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button size="sm" variant="ghost" onClick={() => void load()}>Muat ulang</Button>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada resep.</p> : (
            <Table>
              <THead><TR><TH>Resep</TH><TH>Pasien</TH><TH>Dokter</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {items.map((r) => (
                  <TR key={r.id} data-testid="rx-row">
                    <TD><span className="font-mono text-xs">{r.prescriptionNo}</span><span className="block text-xs text-muted-foreground">{fmtDateTime(r.issuedAt)} · {r.itemCount} baris</span></TD>
                    <TD>{r.patient.name}<span className="block text-xs text-muted-foreground">RM {r.patient.mrn} · {PAYER_TYPE_LABEL[r.payerType]}</span></TD>
                    <TD className="text-xs">{r.prescriberName}</TD>
                    <TD className="flex flex-wrap gap-1">
                      <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                      {r.reviewProblem ? <Badge tone="danger">Ada masalah telaah</Badge> : null}
                      {r.alertCount ? <Badge tone="warning">{r.alertCount} peringatan dokter</Badge> : null}
                      {r.pickupDeadline ? <span className="text-xs text-muted-foreground">Ambil sisa s.d. {fmtDate(r.pickupDeadline)}</span> : null}
                    </TD>
                    <TD className="text-right"><Button size="sm" onClick={() => setOpen(r.id)}>Buka</Button></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {open ? <RxDialog id={open} onClose={() => { setOpen(undefined); void load(); }} /> : null}
    </div>
  );
}

function RxDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [rx, setRx] = useState<PharmacyPrescription>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [mode, setMode] = useState<'view' | 'review' | 'dispense' | 'close'>('view');
  const [subFor, setSubFor] = useState<RxPharmacyItem>();
  const load = useCallback(async () => {
    try { setRx(await api<PharmacyPrescription>(`/pharmacy/prescriptions/${id}`)); } catch (e) { setError(errorText(e, 'Gagal memuat resep')); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const done = async (msg: string, next?: PharmacyPrescription) => { setMode('view'); setNotice(msg); if (next) setRx(next); else await load(); };
  const openRx = rx && ['ISSUED', 'VERIFIED', 'PARTIALLY_DISPENSED'].includes(rx.status);
  async function cancelSub(subId: string) {
    setError(undefined);
    try { await api(`/pharmacy/substitutions/${subId}/cancel`, { method: 'POST' }); await done('Pengajuan substitusi dibatalkan.'); }
    catch (e) { setError(errorText(e, 'Gagal membatalkan substitusi')); }
  }
  return (
    <Dialog open onClose={onClose} title={rx ? `Resep ${rx.prescriptionNo}` : 'Resep'}>
      <div className="grid gap-4" data-testid="rx-dialog">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {!rx ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : (
          <>
            <section className="grid gap-1 text-sm">
              <p><strong>{rx.patient.name}</strong> · RM {rx.patient.mrn} · lahir {fmtDate(rx.patient.birthDate)} · {PAYER_TYPE_LABEL[rx.encounter.payerType]}</p>
              <p className="text-xs text-muted-foreground">{rx.prescriber.name}{rx.prescriber.sipNumber ? ` · SIP ${rx.prescriber.sipNumber}` : ''} · {fmtDateTime(rx.issuedAt)} · kunjungan {rx.encounter.encounterNo}</p>
              {rx.patient.allergies.length ? (
                <Alert tone="error">Alergi: {rx.patient.allergies.map((a) => `${a.substance}${a.severity ? ` (${a.severity.toLowerCase()})` : ''}`).join(', ')}</Alert>
              ) : <p className="text-xs text-muted-foreground">Tidak ada alergi aktif tercatat.</p>}
              {rx.alerts.length ? (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:bg-amber-950" data-testid="rx-alerts">
                  <p className="font-medium">Peringatan saat diresepkan (alasan dokter):</p>
                  <ul className="list-disc pl-4">{rx.alerts.map((a) => <li key={a.key}>{a.message}{a.reason ? ` — ${a.reason}` : ''}</li>)}</ul>
                </div>
              ) : null}
              {rx.notes ? <p className="text-xs">Catatan dokter: {rx.notes}</p> : null}
            </section>
            <Table>
              <THead><TR><TH>#</TH><TH>Obat & aturan pakai</TH><TH className="text-right">Diresepkan</TH><TH className="text-right">Diserahkan</TH><TH className="text-right">Sisa</TH></TR></THead>
              <TBody>
                {rx.items.map((i) => (
                  <TR key={i.id} data-testid="rx-item">
                    <TD className="text-xs">{i.lineNo}</TD>
                    <TD><span className="font-medium">{itemName(i)}</span>
                      {i.components.length ? <span className="block text-xs text-muted-foreground">{i.components.map((c) => `${c.drugName} ${qty(c.qty)} ${c.uomName}`).join(' + ')}</span> : null}
                      <span className="block text-xs">{i.frequency}{i.dose ? ` @ ${i.dose}` : ''}{i.durationDays ? ` · ${i.durationDays} hari` : ''}{i.instructions ? ` · ${i.instructions}` : ''}</span>
                      {i.closeReason ? <span className="block text-xs text-muted-foreground">Ditutup: {i.closeReason}</span> : null}
                      {i.substitutedFromName ? <span className="block text-xs text-muted-foreground">Pengganti dari {i.substitutedFromName} (disetujui dokter)</span> : null}
                      {i.substitution?.status === 'REQUESTED' ? (
                        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs" data-testid="sub-pending">
                          <Badge tone="warning">Menunggu dokter: → {i.substitution.toDrugName}</Badge>
                          <Button size="sm" variant="ghost" onClick={() => void cancelSub(i.substitution!.id)}>Batalkan substitusi</Button>
                        </span>
                      ) : i.substitution?.status === 'REJECTED' ? (
                        <span className="block text-xs text-destructive">Substitusi ke {i.substitution.toDrugName} ditolak{i.substitution.decisionNote ? `: ${i.substitution.decisionNote}` : ''}</span>
                      ) : null}
                      {openRx && mode === 'view' && i.kind === 'DRUG' && i.qtyDispensed === 0 && i.remaining > 0 && i.substitution?.status !== 'REQUESTED' ? (
                        <Button size="sm" variant="ghost" className="mt-1" onClick={() => setSubFor(i)}>Ajukan substitusi</Button>
                      ) : null}</TD>
                    <TD className="text-right tabular-nums">{qty(i.qty)} {i.uomName}</TD>
                    <TD className="text-right tabular-nums">{qty(i.qtyDispensed)}</TD>
                    <TD className="text-right tabular-nums">{qty(i.remaining)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <p className="text-sm">
              Status: <Badge tone={STATUS_TONE[rx.status]}>{STATUS_LABEL[rx.status]}</Badge>
              {rx.pickupDeadline ? <span className="ml-2 text-xs">Sisa dapat diambil s.d. {fmtDateTime(rx.pickupDeadline)}</span> : null}
              {rx.closedReason ? <span className="ml-2 text-xs">Alasan ditutup: {rx.closedReason}</span> : null}
            </p>
            {rx.review ? (
              <p className="text-xs text-muted-foreground" data-testid="review-summary">
                Telaah {rx.review.result === 'OK' ? 'sesuai' : 'menemukan masalah'} oleh {rx.review.reviewerName ?? '—'} · {fmtDateTime(rx.review.reviewedAt)}
                {rx.review.result === 'PROBLEM' ? ` — ${Object.entries(rx.review.items).filter(([, x]) => !x.ok)
                  .map(([k, x]) => `${rx.checklist.find((c) => c.key === k)?.label}: ${x.note}`).join('; ')}` : ''}
              </p>
            ) : null}
            {subFor ? <SubstitutionForm rxId={rx.id} item={subFor} onCancel={() => setSubFor(undefined)}
                                        onDone={() => { setSubFor(undefined); void done('Pengajuan substitusi dikirim ke dokter.'); }} /> : null}
            {mode === 'review' ? <ReviewForm rx={rx} onCancel={() => setMode('view')} onDone={(r) => void done(r.status === 'VERIFIED' ? 'Telaah sesuai — resep siap diserahkan.' : 'Masalah telaah dicatat. Hubungi dokter penulis resep.', r)} /> : null}
            {mode === 'dispense' ? <DispenseForm rx={rx} onCancel={() => setMode('view')} onDone={(r) => void done(
              r.prescriptionStatus === 'DISPENSED' ? 'Obat diserahkan. Resep selesai.' : 'Obat diserahkan sebagian; sisa tercatat.')} /> : null}
            {mode === 'close' ? <CloseForm rx={rx} onCancel={() => setMode('view')} onDone={(r) => void done('Sisa resep ditutup dan tidak ditagih.', r)} /> : null}
            {rx.dispenses.length ? (
              <section className="grid gap-2">
                <h3 className="text-sm font-medium">Penyerahan</h3>
                {rx.dispenses.map((d) => (
                  <div key={d.id} className="rounded-md border p-2 text-xs" data-testid="dispense-card">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{fmtDateTime(d.dispensedAt)} · {d.dispensedByName} · {d.locationName}{d.handedTo ? ` · diterima ${d.handedTo}` : ''}</span>
                      <a className="ml-auto underline" href={`/api/v1/pharmacy/dispenses/${d.id}/labels`} target="_blank" rel="noreferrer">Cetak etiket</a>
                    </div>
                    <ul className="mt-1">
                      {d.lines.map((l) => (
                        <li key={l.id}>{l.drugName} · batch {l.batchNo} (ED {fmtDate(l.expiryDate)}) · {qty(l.qtyBase)} {l.uomName} × {fmtRupiah(l.unitPrice)} = {fmtRupiah(l.amount)}
                          {l.batchReason ? <span className="text-muted-foreground"> · batch manual: {l.batchReason}</span> : null}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            ) : null}
            {rx.medicationHistory.length ? (
              <details className="text-xs">
                <summary className="cursor-pointer">Riwayat obat pasien (90 hari)</summary>
                <ul className="mt-1">{rx.medicationHistory.map((h, n) => <li key={n}>{fmtDate(h.dispensedAt)} · {h.drugName} {qty(h.qty)} {h.uomName} · {h.prescriptionNo}</li>)}</ul>
              </details>
            ) : null}
            {mode === 'view' ? (
              <div className="flex flex-wrap justify-end gap-2">
                {openRx && rx.status !== 'PARTIALLY_DISPENSED' ? <Button variant="outline" onClick={() => { setNotice(undefined); setMode('review'); }}>Telaah resep</Button> : null}
                {openRx ? <Button variant="outline" onClick={() => { setNotice(undefined); setMode('close'); }}>Tutup sisa resep</Button> : null}
                {openRx && rx.status !== 'ISSUED' ? <Button onClick={() => { setNotice(undefined); setMode('dispense'); }}>Serahkan obat</Button> : null}
                <Button variant="outline" onClick={onClose}>Tutup</Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

function ReviewForm({ rx, onCancel, onDone }: { rx: PharmacyPrescription; onCancel: () => void; onDone: (r: PharmacyPrescription) => void }) {
  const [f, setF] = useState<Record<string, { ok: boolean | null; note: string }>>(() =>
    Object.fromEntries(rx.checklist.map((c) => [c.key, { ok: rx.review?.items[c.key]?.ok ?? null, note: rx.review?.items[c.key]?.note ?? '' }])));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const complete = rx.checklist.every((c) => f[c.key].ok === true || (f[c.key].ok === false && f[c.key].note.trim().length >= 3));
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      onDone(await api<PharmacyPrescription>(`/pharmacy/prescriptions/${rx.id}/review`, { method: 'POST', headers: { 'if-match': String(rx.version) },
        body: { items: Object.fromEntries(Object.entries(f).map(([k, x]) => [k, { ok: x.ok === true, note: x.ok ? null : x.note.trim() }])) } }));
    } catch (err) { setError(errorText(err, 'Gagal menyimpan telaah')); } finally { setBusy(false); }
  }
  return (
    <form className="grid gap-3 rounded-md border p-3" onSubmit={submit} noValidate data-testid="review-form">
      <h3 className="text-sm font-medium">Telaah resep</h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {(['ADMINISTRATIF', 'FARMASETIK', 'KLINIS'] as const).map((g) => (
        <fieldset key={g} className="grid gap-1">
          <legend className="text-xs font-semibold uppercase text-muted-foreground">{GROUP_LABEL[g]}</legend>
          {rx.checklist.filter((c) => c.group === g).map((c) => (
            <div key={c.key} className="grid gap-1 sm:grid-cols-[1fr_auto]">
              <span className="text-sm">{c.label}</span>
              <div className="flex gap-3 text-sm" role="radiogroup" aria-label={c.label}>
                <label className="flex items-center gap-1"><input type="radio" name={c.key} checked={f[c.key].ok === true}
                  onChange={() => setF({ ...f, [c.key]: { ...f[c.key], ok: true } })} /> Sesuai</label>
                <label className="flex items-center gap-1"><input type="radio" name={c.key} checked={f[c.key].ok === false}
                  onChange={() => setF({ ...f, [c.key]: { ...f[c.key], ok: false } })} /> Masalah</label>
              </div>
              {f[c.key].ok === false ? (
                <Input className="sm:col-span-2" aria-label={`Catatan: ${c.label}`} placeholder="Jelaskan masalahnya" maxLength={500} value={f[c.key].note}
                  onChange={(e) => setF({ ...f, [c.key]: { ...f[c.key], note: e.target.value } })} />
              ) : null}
            </div>
          ))}
        </fieldset>
      ))}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => setF(Object.fromEntries(rx.checklist.map((c) => [c.key, { ok: true, note: '' }])))}>Tandai semua sesuai</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Batal</Button>
        <Button type="submit" disabled={!complete || busy}>Simpan telaah</Button>
      </div>
      <p className="text-xs text-muted-foreground">Daftar periksa ini wajib ditinjau apoteker penanggung jawab sebelum pilot.</p>
    </form>
  );
}

function DispenseForm({ rx, onCancel, onDone }: { rx: PharmacyPrescription; onCancel: () => void; onDone: (r: DispenseResult) => void }) {
  const open = rx.items.filter((i) => i.remaining > 0);
  /** Jumlah usulan: sisa resep, dibatasi stok tersedia (racikan hanya utuh). */
  const suggest = (i: RxPharmacyItem) => {
    const ok = i.stock.every((s) => s.unitPrice !== null && (s.available ?? 0) >= s.need);
    if (i.kind === 'COMPOUND') return ok ? i.remaining : 0;
    const s = i.stock[0];
    return s.unitPrice === null ? 0 : Math.min(i.remaining, s.available ?? 0);
  };
  const [qtys, setQtys] = useState<Record<string, string>>(() => Object.fromEntries(open.map((i) => [i.id, String(suggest(i))])));
  const [handedTo, setHandedTo] = useState('');
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => `dsp-${crypto.randomUUID()}`);
  const lines = open.map((i) => ({ i, q: Number((qtys[i.id] ?? '').replace(',', '.')) })).filter((x) => x.q > 0);
  const total = lines.reduce((t, { i, q }) => t + i.stock.reduce((u, s) => u + (s.unitPrice ? Number(s.unitPrice) * (i.kind === 'COMPOUND' ? s.need * q / i.remaining : q) : 0), 0), 0);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined); setFieldErrors({});
    try {
      onDone(await api<DispenseResult>(`/pharmacy/prescriptions/${rx.id}/dispense`, { method: 'POST',
        headers: { 'if-match': String(rx.version), 'idempotency-key': key },
        body: { handedTo: handedTo.trim() || null, lines: lines.map(({ i, q }) => ({ prescriptionItemId: i.id, qty: q })) } }));
    } catch (err) {
      setError(errorText(err, 'Gagal menyerahkan obat'));
      if (err instanceof ApiError) {
        setFieldErrors(Object.fromEntries((err.problem.errors ?? []).map((x) => {
          const n = Number(x.field.split('.')[1]);
          return [lines[n]?.i.id ?? x.field, x.message];
        })));
      }
    } finally { setBusy(false); }
  }
  return (
    <form className="grid gap-3 rounded-md border p-3" onSubmit={submit} noValidate data-testid="dispense-form">
      <h3 className="text-sm font-medium">Serahkan obat — dari {rx.location?.name ?? '—'} ({rx.dispenseMethod})</h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {open.map((i) => (
        <div key={i.id} className="grid gap-1 rounded border p-2 text-sm sm:grid-cols-[1fr_9rem]" data-testid="dispense-line">
          <div>
            <span className="font-medium">{i.lineNo}. {itemName(i)}</span> <span className="text-xs text-muted-foreground">sisa {qty(i.remaining)} {i.uomName}</span>
            {i.stock.map((s) => (
              <p key={s.drugItemId} className="text-xs">
                {i.kind === 'COMPOUND' ? `${s.drugName}: butuh ${qty(s.need)} · ` : ''}stok {qty(s.available ?? 0)}
                {s.unitPrice ? ` · ${fmtRupiah(s.unitPrice)}/satuan` : <span className="text-destructive"> · belum ada harga jual</span>}
                {s.restricted ? <Badge tone="danger">Golongan terbatas</Badge> : null}
                {s.allocation.length ? <span className="text-muted-foreground"> · batch {s.allocation.map((a) => {
                  const bt = s.batches.find((b) => b.batchId === a.batchId);
                  return `${bt?.batchNo} (ED ${bt ? fmtDate(bt.expiryDate) : ''}) ×${qty(a.qty)}`;
                }).join(', ')}</span> : null}
              </p>
            ))}
            {fieldErrors[i.id] ? <p className="text-xs text-destructive" role="alert">{fieldErrors[i.id]}</p> : null}
          </div>
          <Field id={`dq-${i.id}`} label={`Jumlah diserahkan (${i.uomName})`}>
            <Input id={`dq-${i.id}`} inputMode="decimal" value={qtys[i.id]} disabled={i.kind === 'COMPOUND' && suggest(i) === 0}
              onChange={(e) => setQtys({ ...qtys, [i.id]: e.target.value })} />
          </Field>
        </div>
      ))}
      <Field id="handed" label="Diterima oleh (opsional)"><Input id="handed" maxLength={200} value={handedTo} onChange={(e) => setHandedTo(e.target.value)} placeholder="Pasien sendiri / keluarga" /></Field>
      <p className="text-sm">Perkiraan nilai obat: <strong>{fmtRupiah(String(Math.round(total)))}</strong> <span className="text-xs text-muted-foreground">(belum ditagih; tagihan dibuat di kasir)</span></p>
      {lines.some(({ i, q }) => q < i.remaining) ? <p className="text-xs">Sebagian baris diserahkan kurang dari sisa resep — sisanya dapat diambil kemudian.</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Batal</Button>
        <Button type="submit" disabled={!lines.length || busy}>Simpan penyerahan</Button>
      </div>
    </form>
  );
}

function CloseForm({ rx, onCancel, onDone }: { rx: PharmacyPrescription; onCancel: () => void; onDone: (r: PharmacyPrescription) => void }) {
  const [reason, setReason] = useState('');
  const [preset, setPreset] = useState('');
  const [error, setError] = useState<string>();
  const text = preset === 'LAIN' ? reason.trim() : preset;
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(undefined);
    try {
      onDone(await api<PharmacyPrescription>(`/pharmacy/prescriptions/${rx.id}/close`, { method: 'POST', headers: { 'if-match': String(rx.version) }, body: { reason: text } }));
    } catch (err) { setError(errorText(err, 'Gagal menutup sisa resep')); }
  }
  return (
    <form className="grid gap-3 rounded-md border p-3" onSubmit={submit} noValidate data-testid="close-form">
      <h3 className="text-sm font-medium">Tutup sisa resep</h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field id="close-preset" label="Alasan">
        <Select id="close-preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
          <option value="">Pilih alasan…</option>
          <option value="Pasien tidak menebus resep">Pasien tidak menebus resep</option>
          <option value="Pasien memilih membeli di apotek lain">Pasien memilih membeli di apotek lain</option>
          <option value="Stok kosong, pasien tidak menunggu">Stok kosong, pasien tidak menunggu</option>
          <option value="LAIN">Lainnya…</option>
        </Select>
      </Field>
      {preset === 'LAIN' ? <Field id="close-reason" label="Alasan lain"><Textarea id="close-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field> : null}
      <p className="text-xs text-muted-foreground">Sisa yang ditutup tidak dapat diserahkan lagi dan tidak ditagih.</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Batal</Button>
        <Button type="submit" disabled={text.length < 5}>Tutup sisa</Button>
      </div>
    </form>
  );
}

function SubstitutionForm({ rxId, item, onCancel, onDone }: { rxId: string; item: RxPharmacyItem; onCancel: () => void; onDone: () => void }) {
  const [drug, setDrug] = useState<Drug>();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(undefined);
    try {
      await api(`/pharmacy/prescriptions/${rxId}/substitutions`, { method: 'POST', body: { prescriptionItemId: item.id, newDrugItemId: drug!.id, reason: reason.trim() } });
      onDone();
    } catch (err) { setError(errorText(err, 'Gagal mengajukan substitusi')); }
  }
  return (
    <form className="grid gap-3 rounded-md border p-3" onSubmit={submit} noValidate data-testid="substitution-form">
      <h3 className="text-sm font-medium">Ajukan substitusi — baris {item.lineNo}: {item.drugName}</h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <DrugPicker id="sub-drug" value={drug} onChange={setDrug} />
      <Field id="sub-reason" label="Alasan"><Input id="sub-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Mis. stok kosong" /></Field>
      <p className="text-xs text-muted-foreground">Pengganti harus bersatuan dasar sama. Dokter penulis resep atau dokter yang bertugas di cabang ini memutuskan di aplikasi; selama menunggu, baris ini tidak dapat diserahkan.</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Batal</Button>
        <Button type="submit" disabled={!drug || reason.trim().length < 5}>Kirim ke dokter</Button>
      </div>
    </form>
  );
}
