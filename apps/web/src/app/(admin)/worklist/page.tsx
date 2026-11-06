'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Select, Switch, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { ServiceUnit, WorklistItem, api, errorText } from '../../../lib/api';
import { ENCOUNTER_STATUS, SEX_LABEL } from '../../../lib/format';
import { can, useSession } from '../../../lib/session';

/**
 * Worklist klinis (CLN-FR-001): pasien hari ini yang sudah hadir. Tampilan perawat: belum/ sudah ditriase. Tampilan
 * dokter: urut antrean, yang sedang diperiksa paling atas; "Mulai periksa" menandai pasien sedang diperiksa lalu
 * membuka layar encounter. Diperbarui otomatis tiap 30 detik.
 */
export default function WorklistPage() {
  const s = useSession();
  const router = useRouter();
  const doctor = can(s, 'clinical.note.write');
  const [view, setView] = useState<'NURSE' | 'DOCTOR'>(doctor ? 'DOCTOR' : 'NURSE');
  const [unit, setUnit] = useState('');
  const [mine, setMine] = useState(false);
  const [units, setUnits] = useState<ServiceUnit[]>([]);
  const [items, setItems] = useState<WorklistItem[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  useEffect(() => { void api<ServiceUnit[]>('/service-units').then((u) => setUnits(u.filter((x) => x.unitType === 'POLI' || x.unitType === 'RUANG'))).catch(() => undefined); }, []);
  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ view });
      if (unit) p.set('unitId', unit);
      if (mine) p.set('mine', 'true');
      setItems(await api<WorklistItem[]>(`/clinical/worklist?${p}`)); setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal memuat worklist')); }
  }, [view, unit, mine]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 30_000); return () => clearInterval(t); }, [load]);

  async function start(w: WorklistItem) {
    setBusy(w.id);
    try { await api(`/encounters/${w.id}/start-consultation`, { method: 'POST' }); router.push(`/encounters/${w.id}`); }
    catch (e) { setError(errorText(e, 'Gagal memulai pemeriksaan')); setBusy(undefined); }
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Worklist klinis</h1>
        <div className="ml-auto flex rounded-md border p-0.5" role="tablist" aria-label="Tampilan">
          {(['NURSE', 'DOCTOR'] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v}
                    className={`rounded px-3 py-1 text-sm ${view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                    onClick={() => setView(v)}>{v === 'NURSE' ? 'Perawat' : 'Dokter'}</button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select aria-label="Poli" className="w-56" value={unit} onChange={(e) => setUnit(e.target.value)}>
          <option value="">Semua poli</option>
          {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        {doctor ? (
          <label className="flex items-center gap-2 text-sm"><Switch checked={mine} onChange={(e) => setMine(e.target.checked)} aria-label="Hanya pasien saya" /> Hanya pasien saya</label>
        ) : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada pasien menunggu.</p>
          ) : (
            <Table>
              <THead><TR><TH>Antrean</TH><TH>Pasien</TH><TH>Poli / dokter</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {items.map((w) => {
                  const st = ENCOUNTER_STATUS[w.status];
                  return (
                    <TR key={w.id} data-testid="worklist-row">
                      <TD className="font-mono text-lg font-semibold">{w.queue?.displayCode ?? '—'}<span className="block text-xs font-normal text-muted-foreground">{w.localTime}</span></TD>
                      <TD>
                        <span className="font-medium">{w.patient.fullName}</span>
                        {w.allergyCount > 0 ? <Badge tone="danger" className="ml-2">⚠ Alergi</Badge> : null}
                        <span className="block text-xs text-muted-foreground">{w.patient.mrn} · {SEX_LABEL[w.patient.sex as keyof typeof SEX_LABEL] ?? w.patient.sex} · {w.patient.age}</span>
                      </TD>
                      <TD className="text-xs">{w.unitName}<span className="block text-muted-foreground">{w.practitionerName}</span></TD>
                      <TD>
                        <Badge tone={st.tone as 'info'}>{st.label}</Badge>
                        <span className="block text-xs text-muted-foreground">{w.triagedAt ? 'Vital ✓' : 'Vital belum'}{w.noteStatus ? ` · SOAP ${w.noteStatus === 'SIGNED' ? 'disahkan' : 'draft'}` : ''}</span>
                      </TD>
                      <TD className="text-right">
                        <div className="flex justify-end gap-2">
                          {view === 'DOCTOR' && doctor && w.status !== 'IN_CONSULTATION' ? (
                            <Button size="sm" loading={busy === w.id} onClick={() => void start(w)}>Mulai periksa</Button>
                          ) : null}
                          <Link className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted" href={`/encounters/${w.id}`}>
                            {view === 'NURSE' && !w.triagedAt ? 'Isi vital' : 'Buka'}
                          </Link>
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
