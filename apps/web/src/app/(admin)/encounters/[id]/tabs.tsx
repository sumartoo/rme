'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, Field, Input, Select, TBody, TD, TH, THead, TR, Table, Textarea } from '@clinicrme/ui';
import {
  Allergy, ApiError, ClinicalTemplate, Concept, Diagnosis, EncounterChart, HistoryEntry, Page, ServiceItem, TemplateCode, TemplateField, api, errorText,
} from '../../../../lib/api';
import { fmtDateTime } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

type TabProps = { chart: EncounterChart; onSaved: () => Promise<void> };

/** Label & batas input tanda vital — sama dengan API (batas salah ketik, bukan peringatan klinis). [REVIEW-MEDIS] */
export const VITAL_LABELS: Record<string, { label: string; unit: string; key?: string; min?: number; max?: number; step?: string }> = {
  SYSTOLIC: { label: 'TD sistolik', unit: 'mmHg', key: 'systolic', min: 40, max: 300 },
  DIASTOLIC: { label: 'TD diastolik', unit: 'mmHg', key: 'diastolic', min: 20, max: 200 },
  HEART_RATE: { label: 'Nadi', unit: 'x/menit', key: 'heartRate', min: 20, max: 300 },
  RESP_RATE: { label: 'Napas', unit: 'x/menit', key: 'respRate', min: 4, max: 80 },
  TEMPERATURE: { label: 'Suhu', unit: '°C', key: 'temperature', min: 30, max: 45, step: '0.1' },
  SPO2: { label: 'SpO₂', unit: '%', key: 'spo2', min: 50, max: 100 },
  WEIGHT: { label: 'Berat badan', unit: 'kg', key: 'weight', min: 0.3, max: 400, step: '0.1' },
  HEIGHT: { label: 'Tinggi badan', unit: 'cm', key: 'height', min: 20, max: 250, step: '0.1' },
  PAIN_SCALE: { label: 'Skala nyeri', unit: '0–10', key: 'painScale', min: 0, max: 10 },
  BMI: { label: 'IMT', unit: 'kg/m²' },
};
const INPUTS = Object.entries(VITAL_LABELS).filter(([, v]) => v.key);
const conflict = (e: unknown) => e instanceof ApiError && e.status === 412
  ? 'Catatan sudah diubah orang lain. Muat ulang halaman lalu ulangi perubahan Anda.' : null;
const fieldErrors = (e: unknown) => e instanceof ApiError && e.problem.errors?.length ? e.problem.errors.map((x) => x.message).join('; ') : null;

export function VitalsTab({ chart, onSaved }: TabProps) {
  const s = useSession();
  const write = can(s, 'clinical.vitals.write') && chart.editable;
  const [f, setF] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const out = INPUTS.map(([code, v]) => ({ code, v, val: f[v.key!] ?? '' }));
  const invalid = out.find((o) => o.val !== '' && (Number.isNaN(Number(o.val)) || Number(o.val) < o.v.min! || Number(o.val) > o.v.max!));
  const filled = out.filter((o) => o.val !== '');
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api(`/encounters/${chart.encounter.id}/vitals`, { method: 'POST', body: Object.fromEntries(filled.map((o) => [o.v.key, Number(o.val)])) });
      setF({}); setError(undefined); await onSaved();
    } catch (err) { setError(fieldErrors(err) ?? errorText(err, 'Gagal menyimpan tanda vital')); }
    finally { setBusy(false); }
  }
  return (
    <div className="grid gap-4">
      {write ? (
        <Card>
          <CardHeader><CardTitle>Rekam tanda vital</CardTitle></CardHeader>
          <CardContent>
            <form className="grid gap-3" onSubmit={save} noValidate>
              {error ? <Alert tone="error">{error}</Alert> : null}
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {out.map(({ code, v, val }) => (
                  <Field key={code} id={`v-${v.key}`} label={`${v.label} (${v.unit})`}
                         error={invalid?.code === code ? `${v.min}–${v.max}` : undefined}>
                    <Input id={`v-${v.key}`} inputMode="decimal" value={val} onChange={(e) => setF((x) => ({ ...x, [v.key!]: e.target.value.replace(',', '.') }))} />
                  </Field>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">IMT dihitung otomatis dari berat & tinggi badan.</p>
              <Button type="submit" className="justify-self-start" loading={busy} disabled={!filled.length || !!invalid}>Simpan tanda vital</Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader><CardTitle>Riwayat tanda vital kunjungan ini</CardTitle></CardHeader>
        <CardContent>
          {chart.vitals.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada.</p> : (
            <Table>
              <THead><TR><TH>Waktu</TH><TH>Nilai</TH><TH>Oleh</TH></TR></THead>
              <TBody>
                {chart.vitals.map((v) => (
                  <TR key={v.recordedAt} data-testid="vital-row">
                    <TD className="text-xs">{fmtDateTime(v.recordedAt)}</TD>
                    <TD className="text-sm">{Object.entries(v.values).map(([k, n]) => `${VITAL_LABELS[k]?.label ?? k} ${n} ${VITAL_LABELS[k]?.unit ?? ''}`).join(' · ')}</TD>
                    <TD className="text-xs">{v.recordedByName}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const SOAP = [
  { key: 'subjective', section: 'S', label: 'S — Subjektif (anamnesis)' }, { key: 'objective', section: 'O', label: 'O — Objektif (pemeriksaan)' },
  { key: 'assessment', section: 'A', label: 'A — Asesmen' }, { key: 'plan', section: 'P', label: 'P — Rencana' },
] as const;
type SoapKey = (typeof SOAP)[number]['key'];

export function SoapTab({ chart, onSaved }: TabProps) {
  const s = useSession();
  const full = can(s, 'clinical.note.write') && chart.editable;
  const nurse = !full && can(s, 'clinical.vitals.write') && chart.editable;
  const n = chart.note;
  const [templates, setTemplates] = useState<ClinicalTemplate[]>([]);
  const [template, setTemplate] = useState<TemplateCode>(chart.templateCode);
  const [text, setText] = useState<Record<SoapKey, string>>({ subjective: n?.subjective ?? '', objective: n?.objective ?? '', assessment: n?.assessment ?? '', plan: n?.plan ?? '' });
  const [structured, setStructured] = useState<Record<string, unknown>>(n?.structured ?? {});
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<ClinicalTemplate[]>('/clinical/templates').then(setTemplates).catch(() => undefined); }, []);
  const fields = useMemo(() => templates.find((t) => t.code === template)?.fields ?? [], [templates, template]);
  const dirty = template !== chart.templateCode || SOAP.some((x) => (text[x.key] || null) !== (n?.[x.key] ?? null))
    || JSON.stringify(structured) !== JSON.stringify(n?.structured ?? {});

  async function save() {
    setBusy(true); setSaved(undefined);
    try {
      const headers = { 'if-match': String(n?.version ?? 0) };
      if (nurse) await api(`/encounters/${chart.encounter.id}/anamnesis`, { method: 'PUT', headers, body: { subjective: text.subjective } });
      else {
        const clean = Object.fromEntries(Object.entries(structured).filter(([k, v]) => v !== '' && v !== null && v !== undefined && fields.some((f) => f.key === k)));
        await api(`/encounters/${chart.encounter.id}/note`, { method: 'PUT', headers,
          body: { templateCode: template, ...Object.fromEntries(SOAP.map((x) => [x.key, text[x.key]])), structured: clean } });
      }
      setError(undefined); setSaved('Draft tersimpan.'); await onSaved();
    } catch (e) { setError(conflict(e) ?? fieldErrors(e) ?? errorText(e, 'Gagal menyimpan')); }
    finally { setBusy(false); }
  }
  const fieldInput = (f: TemplateField) => {
    const v = structured[f.key];
    const set = (x: unknown) => setStructured((o) => ({ ...o, [f.key]: x }));
    const id = `st-${f.key}`;
    const label = f.unit ? `${f.label} (${f.unit})` : f.label;
    if (f.type === 'select') {
      return (
        <Field key={f.key} id={id} label={label} hint={f.hint}>
          <Select id={id} value={String(v ?? '')} disabled={!full} onChange={(e) => set(e.target.value || undefined)}>
            <option value="">—</option>{f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
          </Select>
        </Field>
      );
    }
    return (
      <Field key={f.key} id={id} label={label} hint={f.hint}>
        <Input id={id} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined} disabled={!full}
               maxLength={f.maxLength} value={String(v ?? '')}
               onChange={(e) => set(f.type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value.replace(',', '.'))) : e.target.value)} />
      </Field>
    );
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-3">
          Catatan SOAP
          {n ? <Badge tone={n.status === 'SIGNED' ? 'success' : 'neutral'}>{n.status === 'SIGNED' ? 'Disahkan' : 'Draft'}</Badge> : null}
          <span className="ml-auto flex items-center gap-2 text-sm font-normal">
            <label htmlFor="tpl" className="text-muted-foreground">Template</label>
            <Select id="tpl" className="w-40" value={template} disabled={!full} onChange={(e) => setTemplate(e.target.value as TemplateCode)}>
              {(templates.length ? templates : [{ code: chart.templateCode, name: chart.templateCode }]).map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
            </Select>
          </span>
        </CardTitle>
        {n ? <p className="text-xs text-muted-foreground">Terakhir diubah {fmtDateTime(n.updatedAt)}{n.updatedByName ? ` oleh ${n.updatedByName}` : ''}</p> : null}
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {saved && !dirty ? <Alert tone="success" data-testid="soap-saved">{saved}</Alert> : null}
        {nurse ? <p className="text-sm text-muted-foreground">Perawat mengisi anamnesis awal (S). Bagian lain diisi dokter.</p> : null}
        {SOAP.map((x) => (
          <div key={x.key} className="grid gap-2">
            <Field id={`soap-${x.key}`} label={x.label}>
              <Textarea id={`soap-${x.key}`} rows={x.key === 'plan' || x.key === 'assessment' ? 3 : 4} maxLength={10_000}
                        disabled={!(full || (nurse && x.key === 'subjective'))} value={text[x.key]}
                        onChange={(e) => setText((t) => ({ ...t, [x.key]: e.target.value }))} />
            </Field>
            {fields.some((f) => f.section === x.section) ? (
              <div className="grid gap-3 rounded-md bg-muted/40 p-3 sm:grid-cols-2 lg:grid-cols-3">{fields.filter((f) => f.section === x.section).map(fieldInput)}</div>
            ) : null}
          </div>
        ))}
        <p className="text-xs text-muted-foreground">Isian template bersifat usulan awal dan perlu ditinjau tenaga medis klinik.</p>
        {full || nurse ? <Button className="justify-self-start" loading={busy} disabled={!dirty} onClick={() => void save()}>Simpan draft</Button> : null}
      </CardContent>
    </Card>
  );
}

function ConceptSearch({ system, label, onPick }: { system: 'ICD10' | 'ICD9CM'; label: string; onPick: (c: Concept) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Concept[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setItems([]); return; }
    const t = setTimeout(() => {
      void api<Concept[]>(`/terminology/concepts?${new URLSearchParams({ system, q: q.trim(), limit: '10' })}`).then(setItems).catch(() => setItems([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, system]);
  return (
    <div className="grid gap-1">
      <Input aria-label={label} placeholder={`${label} — kode atau kata kunci`} value={q} onChange={(e) => setQ(e.target.value)} />
      {items.length ? (
        <ul className="max-h-56 overflow-auto rounded-md border text-sm">
          {items.map((c) => (
            <li key={c.id}>
              <button type="button" className="w-full px-3 py-1.5 text-left hover:bg-muted" onClick={() => { onPick(c); setQ(''); setItems([]); }}>
                <span className="font-mono">{c.code}</span> — {c.display}{c.isFavorite ? ' ★' : ''}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function DiagnosisTab({ chart, onSaved }: TabProps) {
  const s = useSession();
  const write = can(s, 'clinical.note.write') && chart.editable;
  const [error, setError] = useState<string>();
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [svc, setSvc] = useState('');
  const [icd9, setIcd9] = useState<Concept>();
  const [qty, setQty] = useState('1');
  useEffect(() => {
    if (write) void api<Page<ServiceItem>>('/service-items?limit=200').then((r) => setServices(r.data.filter((x) => x.isActive))).catch(() => undefined);
  }, [write]);
  async function setDx(list: Pick<Diagnosis, 'conceptId' | 'rank' | 'caseStatus' | 'note'>[]) {
    try {
      await api(`/encounters/${chart.encounter.id}/diagnoses`, { method: 'PUT', body: list.map((d) => ({ conceptId: d.conceptId, rank: d.rank, caseStatus: d.caseStatus, note: d.note })) });
      setError(undefined); await onSaved();
    } catch (e) { setError(fieldErrors(e) ?? errorText(e, 'Gagal menyimpan diagnosis')); }
  }
  const dx = chart.diagnoses;
  const add = (c: Concept) => {
    if (dx.some((d) => d.conceptId === c.id)) { setError(`${c.code} sudah tercantum.`); return; }
    void setDx([...dx, { conceptId: c.id, rank: dx.some((d) => d.rank === 'PRIMER') ? 'SEKUNDER' : 'PRIMER', caseStatus: 'BARU', note: null }]);
  };
  async function addProc(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api(`/encounters/${chart.encounter.id}/procedures`, { method: 'POST', body: { serviceItemId: svc, conceptId: icd9?.id ?? null, qty: Number(qty) } });
      setSvc(''); setIcd9(undefined); setQty('1'); setError(undefined); await onSaved();
    } catch (err) { setError(fieldErrors(err) ?? errorText(err, 'Gagal menambah tindakan')); }
  }
  async function removeProc(id: string) {
    try { await api(`/encounters/${chart.encounter.id}/procedures/${id}`, { method: 'DELETE' }); await onSaved(); }
    catch (err) { setError(errorText(err, 'Gagal menghapus tindakan')); }
  }
  return (
    <div className="grid gap-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardHeader><CardTitle>Diagnosis (ICD-10)</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          {write ? <ConceptSearch system="ICD10" label="Cari diagnosis" onPick={add} /> : null}
          {dx.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada diagnosis. Satu diagnosis primer wajib sebelum pengesahan.</p> : (
            <Table>
              <THead><TR><TH>Kode</TH><TH>Diagnosis</TH><TH>Jenis</TH><TH>Kasus</TH><TH /></TR></THead>
              <TBody>
                {dx.map((d) => (
                  <TR key={d.id} data-testid="dx-row">
                    <TD className="font-mono">{d.code}</TD>
                    <TD>{d.display}</TD>
                    <TD>
                      {write ? (
                        <Select aria-label={`Jenis ${d.code}`} value={d.rank} onChange={(e) => void setDx(dx.map((x) => x.id === d.id ? { ...x, rank: e.target.value as Diagnosis['rank'] }
                          : e.target.value === 'PRIMER' && x.rank === 'PRIMER' ? { ...x, rank: 'SEKUNDER' } : x))}>
                          <option value="PRIMER">Primer</option><option value="SEKUNDER">Sekunder</option>
                        </Select>
                      ) : <Badge tone={d.rank === 'PRIMER' ? 'info' : 'neutral'}>{d.rank === 'PRIMER' ? 'Primer' : 'Sekunder'}</Badge>}
                    </TD>
                    <TD>
                      {write ? (
                        <Select aria-label={`Kasus ${d.code}`} value={d.caseStatus} onChange={(e) => void setDx(dx.map((x) => x.id === d.id ? { ...x, caseStatus: e.target.value as Diagnosis['caseStatus'] } : x))}>
                          <option value="BARU">Baru</option><option value="LAMA">Lama</option>
                        </Select>
                      ) : d.caseStatus === 'BARU' ? 'Baru' : 'Lama'}
                    </TD>
                    <TD className="text-right">{write ? <Button size="sm" variant="ghost" onClick={() => void setDx(dx.filter((x) => x.id !== d.id))}>Hapus</Button> : null}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Tindakan</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          {write ? (
            <form className="grid gap-3 md:grid-cols-[2fr_2fr_6rem_auto] md:items-end" onSubmit={addProc} noValidate>
              <Field id="proc-svc" label="Layanan">
                <Select id="proc-svc" value={svc} onChange={(e) => setSvc(e.target.value)}>
                  <option value="">— pilih layanan —</option>
                  {services.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select>
              </Field>
              <div className="grid gap-1">
                <span className="text-sm font-medium">Kode ICD-9-CM (opsional)</span>
                {icd9 ? <div className="flex items-center gap-2 text-sm"><span className="font-mono">{icd9.code}</span> {icd9.display}
                  <Button size="sm" variant="ghost" onClick={() => setIcd9(undefined)}>Ganti</Button></div>
                  : <ConceptSearch system="ICD9CM" label="Cari tindakan" onPick={setIcd9} />}
              </div>
              <Field id="proc-qty" label="Jumlah"><Input id="proc-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
              <Button type="submit" disabled={!svc || !(Number(qty) > 0)}>Tambah tindakan</Button>
            </form>
          ) : null}
          {chart.procedures.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada tindakan.</p> : (
            <Table>
              <THead><TR><TH>Layanan</TH><TH>ICD-9-CM</TH><TH>Pelaksana</TH><TH>Jml</TH><TH /></TR></THead>
              <TBody>
                {chart.procedures.map((p) => (
                  <TR key={p.id} data-testid="procedure-row">
                    <TD>{p.serviceName}</TD>
                    <TD className="text-sm">{p.code ? <><span className="font-mono">{p.code}</span> {p.display}</> : '—'}</TD>
                    <TD className="text-xs">{p.performedByName}</TD>
                    <TD>{p.qty}</TD>
                    <TD className="text-right">{write ? <Button size="sm" variant="ghost" onClick={() => void removeProc(p.id)}>Hapus</Button> : null}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const HISTORY_LABEL: Record<HistoryEntry['historyType'], string> = { PENYAKIT: 'Penyakit', OBAT_RUTIN: 'Obat rutin', KELUARGA: 'Riwayat keluarga', SOSIAL: 'Sosial', OPERASI: 'Operasi' };
const STATUS_LABEL = { ACTIVE: 'Aktif', INACTIVE: 'Tidak aktif', ENTERED_IN_ERROR: 'Salah input' } as const;

export function AllergyHistoryTab({ chart, onSaved }: TabProps) {
  const s = useSession();
  const write = can(s, 'clinical.record.write');
  const pid = chart.patient.id;
  const [allergies, setAllergies] = useState<Allergy[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string>();
  const [a, setA] = useState({ substance: '', category: 'OBAT', reaction: '', severity: '' });
  const [h, setH] = useState({ historyType: 'PENYAKIT', description: '' });
  const [statusFor, setStatusFor] = useState<{ kind: 'allergies' | 'history'; id: string; name: string }>();
  const reload = useCallback(async () => {
    const [x, y] = await Promise.all([api<Allergy[]>(`/patients/${pid}/allergies`), api<HistoryEntry[]>(`/patients/${pid}/history`)]);
    setAllergies(x); setHistory(y);
  }, [pid]);
  useEffect(() => { void reload().catch((e) => setError(errorText(e, 'Gagal memuat alergi & riwayat'))); }, [reload]);
  async function run(fn: () => Promise<unknown>, fallback: string) {
    try { await fn(); setError(undefined); await reload(); await onSaved(); return true; }
    catch (e) { setError(fieldErrors(e) ?? errorText(e, fallback)); return false; }
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {error ? <Alert tone="error" className="lg:col-span-2">{error}</Alert> : null}
      <Card>
        <CardHeader><CardTitle>Alergi</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          {write ? (
            <form className="grid gap-2 sm:grid-cols-2" noValidate onSubmit={(e) => { e.preventDefault(); void run(() => api(`/patients/${pid}/allergies`, { method: 'POST',
              body: { substance: a.substance.trim(), category: a.category, reaction: a.reaction || null, severity: a.severity || null } })
              .then(() => setA({ substance: '', category: 'OBAT', reaction: '', severity: '' })), 'Gagal mencatat alergi'); }}>
              <Field id="al-substance" label="Zat / bahan"><Input id="al-substance" maxLength={200} value={a.substance} onChange={(e) => setA({ ...a, substance: e.target.value })} /></Field>
              <Field id="al-category" label="Kategori">
                <Select id="al-category" value={a.category} onChange={(e) => setA({ ...a, category: e.target.value })}>
                  <option value="OBAT">Obat</option><option value="MAKANAN">Makanan</option><option value="LINGKUNGAN">Lingkungan</option><option value="LAINNYA">Lainnya</option>
                </Select>
              </Field>
              <Field id="al-reaction" label="Reaksi"><Input id="al-reaction" maxLength={500} value={a.reaction} onChange={(e) => setA({ ...a, reaction: e.target.value })} /></Field>
              <Field id="al-severity" label="Keparahan">
                <Select id="al-severity" value={a.severity} onChange={(e) => setA({ ...a, severity: e.target.value })}>
                  <option value="">—</option><option value="RINGAN">Ringan</option><option value="SEDANG">Sedang</option><option value="BERAT">Berat</option>
                </Select>
              </Field>
              <Button type="submit" className="justify-self-start" disabled={a.substance.trim().length < 2}>Catat alergi</Button>
            </form>
          ) : null}
          <ul className="grid gap-2 text-sm">
            {allergies.length === 0 ? <li className="text-muted-foreground">Belum ada alergi tercatat.</li> : allergies.map((x) => (
              <li key={x.id} data-testid="allergy-row" className={`flex items-start gap-2 border-b pb-2 last:border-0 ${x.status !== 'ACTIVE' ? 'text-muted-foreground line-through' : ''}`}>
                <div className="flex-1"><b>{x.substance}</b> · {x.category.toLowerCase()}{x.severity ? ` · ${x.severity.toLowerCase()}` : ''}{x.reaction ? ` · ${x.reaction}` : ''}
                  <span className="block text-xs no-underline">{STATUS_LABEL[x.status]}{x.statusReason ? ` — ${x.statusReason}` : ''} · {x.recordedByName}</span></div>
                {write && x.status === 'ACTIVE' ? <Button size="sm" variant="ghost" onClick={() => setStatusFor({ kind: 'allergies', id: x.id, name: x.substance })}>Ubah status</Button> : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Riwayat penyakit & obat rutin</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          {write ? (
            <form className="grid gap-2" noValidate onSubmit={(e) => { e.preventDefault(); void run(() => api(`/patients/${pid}/history`, { method: 'POST',
              body: { historyType: h.historyType, description: h.description.trim() } }).then(() => setH({ ...h, description: '' })), 'Gagal mencatat riwayat'); }}>
              <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
                <Field id="hi-type" label="Jenis">
                  <Select id="hi-type" value={h.historyType} onChange={(e) => setH({ ...h, historyType: e.target.value })}>
                    {Object.entries(HISTORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                </Field>
                <Field id="hi-desc" label="Keterangan"><Input id="hi-desc" maxLength={1000} value={h.description} onChange={(e) => setH({ ...h, description: e.target.value })} /></Field>
              </div>
              <Button type="submit" className="justify-self-start" disabled={h.description.trim().length < 2}>Catat riwayat</Button>
            </form>
          ) : null}
          <ul className="grid gap-2 text-sm">
            {history.length === 0 ? <li className="text-muted-foreground">Belum ada riwayat.</li> : history.map((x) => (
              <li key={x.id} data-testid="history-entry" className={`flex items-start gap-2 border-b pb-2 last:border-0 ${x.status !== 'ACTIVE' ? 'text-muted-foreground line-through' : ''}`}>
                <div className="flex-1"><b className="text-xs uppercase">{HISTORY_LABEL[x.historyType]}</b> {x.description}
                  <span className="block text-xs">{STATUS_LABEL[x.status]}{x.statusReason ? ` — ${x.statusReason}` : ''} · {x.recordedByName}</span></div>
                {write && x.status === 'ACTIVE' ? <Button size="sm" variant="ghost" onClick={() => setStatusFor({ kind: 'history', id: x.id, name: x.description })}>Ubah status</Button> : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {statusFor ? <StatusDialog name={statusFor.name} onClose={() => setStatusFor(undefined)}
        onSubmit={(body) => run(() => api(`/patients/${pid}/${statusFor.kind}/${statusFor.id}/status`, { method: 'POST', body }), 'Gagal mengubah status')
          .then((ok) => { if (ok) setStatusFor(undefined); })} /> : null}
    </div>
  );
}

function StatusDialog({ name, onClose, onSubmit }: { name: string; onClose: () => void; onSubmit: (b: { status: string; reason: string }) => Promise<void> }) {
  const [status, setStatus] = useState('INACTIVE');
  const [reason, setReason] = useState('');
  return (
    <Dialog open onClose={onClose} title="Ubah status" description={name}>
      <form className="grid gap-3" noValidate onSubmit={(e) => { e.preventDefault(); void onSubmit({ status, reason: reason.trim() }); }}>
        <Field id="st-status" label="Status baru">
          <Select id="st-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="INACTIVE">Tidak aktif lagi</option><option value="ENTERED_IN_ERROR">Salah input</option>
          </Select>
        </Field>
        <Field id="st-reason" label="Alasan *"><Input id="st-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" disabled={reason.trim().length < 3}>Simpan</Button>
        </div>
      </form>
    </Dialog>
  );
}
