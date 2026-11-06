'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@clinicrme/ui';
import { MedicalRecordEntry, Page, Patient, api, errorText } from '../../../../../lib/api';
import { ENCOUNTER_STATUS, fmtDate, fmtDateTime } from '../../../../../lib/format';

const SOAP = [['subjective', 'S'], ['objective', 'O'], ['assessment', 'A'], ['plan', 'P']] as const;

/** Riwayat rekam medis pasien lintas kunjungan (CLN-FR-016). Setiap pembukaan tercatat di audit (API). */
export default function MedicalRecordsPage() {
  const { id } = useParams<{ id: string }>();
  const [patient, setPatient] = useState<Patient>();
  const [items, setItems] = useState<MedicalRecordEntry[]>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const load = useCallback(async (after?: string) => {
    try {
      const r = await api<Page<MedicalRecordEntry>>(`/patients/${id}/medical-records?limit=10${after ? `&cursor=${after}` : ''}`);
      setItems((x) => (after ? [...(x ?? []), ...r.data] : r.data)); setCursor(r.page.nextCursor); setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal memuat riwayat rekam medis')); }
  }, [id]);
  useEffect(() => { void load(); void api<Patient>(`/patients/${id}`).then(setPatient).catch(() => undefined); }, [id, load]);
  return (
    <div className="grid gap-4">
      <div className="text-sm"><Link className="text-muted-foreground hover:underline" href={`/patients/${id}`}>← Data pasien</Link></div>
      <h1 className="text-xl font-semibold">Riwayat rekam medis{patient ? ` — ${patient.fullName}` : ''}</h1>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada catatan klinis.</p> : items.map((r) => (
        <Card key={r.encounterId} data-testid="record-entry">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {fmtDate(r.localDate)} · {r.unitName} · {r.practitionerName}
              <Badge tone={ENCOUNTER_STATUS[r.status].tone as 'info'}>{ENCOUNTER_STATUS[r.status].label}</Badge>
              {r.note ? <Badge tone={r.note.status === 'SIGNED' ? 'success' : 'neutral'}>{r.note.status === 'SIGNED' ? 'Disahkan' : 'Draft'}</Badge> : null}
              <Link className="ml-auto text-sm font-normal underline" href={`/encounters/${r.encounterId}`}>{r.encounterNo}</Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {r.diagnoses.length ? <p><b>Diagnosis:</b> {r.diagnoses.map((d) => `${d.code} ${d.display}${d.rank === 'PRIMER' ? ' (primer)' : ''}`).join('; ')}</p> : null}
            {r.note ? SOAP.filter(([k]) => r.note?.[k]).map(([k, l]) => <p key={k} className="whitespace-pre-wrap"><b>{l}:</b> {r.note?.[k]}</p>) : null}
            {r.procedures.length ? <p><b>Tindakan:</b> {r.procedures.map((p) => `${p.serviceName}${p.code ? ` (${p.code})` : ''}`).join('; ')}</p> : null}
            {r.note?.status === 'SIGNED' ? <p className="text-xs text-muted-foreground">Disahkan {r.note.signedByName} · {fmtDateTime(r.note.signedAt)}</p> : null}
            {r.note?.addenda.map((a) => (
              <div key={a.id} className="rounded-md border p-2" data-testid="record-addendum">
                <p className="text-xs text-muted-foreground">Addendum {fmtDateTime(a.signedAt)} · {a.authorName} · {a.reason}</p>
                <p className="whitespace-pre-wrap">{a.content}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
      {cursor ? <Button variant="outline" className="justify-self-start" onClick={() => void load(cursor)}>Muat lebih banyak</Button> : null}
    </div>
  );
}
