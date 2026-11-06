'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@clinicrme/ui';
import { ApiError, EncounterChart, api, errorText } from '../../../../lib/api';
import { ENCOUNTER_STATUS, PAYER_TYPE_LABEL, SEX_LABEL, fmtDate } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';
import { DocumentsTab, LabTab } from './lab-docs';
import { RxTab } from './rx';
import { SignPanel } from './sign';
import { AllergyHistoryTab, DiagnosisTab, SoapTab, VitalsTab, VITAL_LABELS } from './tabs';

const TABS = [
  { key: 'summary', label: 'Ringkasan' }, { key: 'vitals', label: 'Tanda vital' }, { key: 'soap', label: 'SOAP' },
  { key: 'dx', label: 'Diagnosis & tindakan' }, { key: 'rx', label: 'Resep' }, { key: 'lab', label: 'Lab' },
  { key: 'docs', label: 'Dokumen & kontrol' }, { key: 'allergy', label: 'Alergi & riwayat' },
] as const;
type Tab = (typeof TABS)[number]['key'];

/**
 * Layar encounter (CLN-FR-001, 002, 004–009, 016): header pasien dengan alergi menonjol, tanda vital, SOAP + template,
 * diagnosis & tindakan, alergi & riwayat, kunjungan sebelumnya. Setiap pembukaan tercatat di audit (API).
 */
export default function EncounterPage() {
  const { id } = useParams<{ id: string }>();
  const s = useSession();
  const [chart, setChart] = useState<EncounterChart>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>(can(s, 'clinical.note.write') ? 'soap' : 'vitals');
  const load = useCallback(async () => {
    try { setChart(await api<EncounterChart>(`/encounters/${id}/chart`)); setError(undefined); }
    catch (e) { setError(e instanceof ApiError && e.status === 404 ? 'Kunjungan tidak ditemukan.' : errorText(e, 'Gagal memuat rekam medis')); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function start() {
    try { await api(`/encounters/${id}/start-consultation`, { method: 'POST' }); await load(); }
    catch (e) { setError(errorText(e, 'Gagal memulai pemeriksaan')); }
  }

  if (!chart) return error ? <Alert tone="error">{error}</Alert> : <p className="text-sm text-muted-foreground" role="status">Memuat…</p>;
  const { encounter: e, patient: p } = chart;
  const st = ENCOUNTER_STATUS[e.status];
  const latest = chart.vitals[0];
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2 text-sm"><Link className="text-muted-foreground hover:underline" href="/worklist">← Worklist</Link></div>
      <Card>
        <CardContent className="grid gap-2 pt-5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-xl font-semibold" data-testid="chart-patient">{p.fullName}</h1>
            <span className="font-mono text-sm text-muted-foreground">{p.mrn}</span>
            <span className="text-sm">{SEX_LABEL[p.sex as keyof typeof SEX_LABEL] ?? p.sex} · {p.age} · lahir {fmtDate(p.birthDate)}</span>
            <Link className="text-sm underline" href={`/patients/${p.id}/records`}>Riwayat rekam medis</Link>
            <Badge tone={st.tone as 'info'} className="ml-auto">{st.label}</Badge>
          </div>
          <div className="text-sm text-muted-foreground">
            {e.encounterNo} · {e.unitName} · {e.practitionerName} · {PAYER_TYPE_LABEL[e.payerType]}{e.payerName ? ` (${e.payerName})` : ''}
          </div>
          {p.allergies.length ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive" data-testid="allergy-banner" role="alert">
              ⚠ Alergi: {p.allergies.map((a) => `${a.substance}${a.severity ? ` (${a.severity.toLowerCase()})` : ''}`).join(', ')}
            </div>
          ) : <div className="text-xs text-muted-foreground" data-testid="allergy-banner">Belum ada alergi tercatat.</div>}
          {p.processingRestricted ? <div className="text-xs text-amber-800">Pasien meminta pembatasan pemrosesan data (notifikasi & pemrosesan opsional dihentikan).</div> : null}
          {!chart.editable ? <Alert tone="info">{chart.note?.status === 'SIGNED' ? 'Rekam medis sudah disahkan dan terkunci.' : 'Kunjungan sudah selesai atau dibatalkan.'}</Alert> : null}
          {can(s, 'clinical.note.write') && (e.status === 'ARRIVED' || e.status === 'TRIAGED') ? (
            <div><Button size="sm" onClick={() => void start()}>Mulai periksa</Button></div>
          ) : null}
        </CardContent>
      </Card>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <SignPanel chart={chart} onSaved={load} />
      <div className="flex flex-wrap gap-1 border-b" role="tablist" aria-label="Bagian rekam medis">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.key ? 'border-primary font-medium' : 'border-transparent text-muted-foreground'}`}
                  onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'summary' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Tanda vital terakhir</CardTitle></CardHeader>
            <CardContent>
              {latest ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  {Object.entries(latest.values).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{VITAL_LABELS[k]?.label ?? k}</dt><dd>{v} {VITAL_LABELS[k]?.unit}</dd></div>)}
                </dl>
              ) : <p className="text-sm text-muted-foreground">Belum diisi.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Riwayat penyakit & obat rutin</CardTitle></CardHeader>
            <CardContent>
              {p.history.length ? <ul className="grid gap-1 text-sm">{p.history.map((h) => <li key={h.id}><b className="text-xs uppercase text-muted-foreground">{h.historyType.replace('_', ' ')}</b> {h.description}</li>)}</ul>
                : <p className="text-sm text-muted-foreground">Belum ada.</p>}
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Kunjungan sebelumnya</CardTitle></CardHeader>
            <CardContent>
              {chart.previousVisits.length ? (
                <ul className="grid gap-2 text-sm">
                  {chart.previousVisits.map((v) => (
                    <li key={v.id} data-testid="previous-visit" className="border-b pb-2 last:border-0">
                      <span className="font-medium">{fmtDate(v.localDate)}</span> · {v.unitName} · {v.practitionerName} · <Badge tone={ENCOUNTER_STATUS[v.status].tone as 'info'}>{ENCOUNTER_STATUS[v.status].label}</Badge>
                      {v.primaryDiagnosis ? <span className="block">{v.primaryDiagnosis.code} — {v.primaryDiagnosis.display}</span> : null}
                      {v.assessment ? <span className="block text-muted-foreground">{v.assessment}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted-foreground">Ini kunjungan pertama.</p>}
            </CardContent>
          </Card>
        </div>
      ) : null}
      {tab === 'vitals' ? <VitalsTab chart={chart} onSaved={load} /> : null}
      {tab === 'soap' ? <SoapTab chart={chart} onSaved={load} /> : null}
      {tab === 'dx' ? <DiagnosisTab chart={chart} onSaved={load} /> : null}
      {tab === 'rx' ? <RxTab chart={chart} onSaved={load} /> : null}
      {tab === 'lab' ? <LabTab chart={chart} /> : null}
      {tab === 'docs' ? <DocumentsTab chart={chart} /> : null}
      {tab === 'allergy' ? <AllergyHistoryTab chart={chart} onSaved={load} /> : null}
    </div>
  );
}
