'use client';
import { useEffect, useState } from 'react';
import { Badge } from '@clinicrme/ui';
import { EncounterSyncStatus, api } from '../../../../lib/api';
import { fmtDateTime } from '../../../../lib/format';

const LABEL: Record<string, { text: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  NOT_SIGNED: { text: 'Menunggu RM disahkan', tone: 'neutral' },
  QUEUED: { text: 'Dalam antrean kirim', tone: 'info' },
  PENDING: { text: 'Dicoba ulang', tone: 'warning' },
  BLOCKED: { text: 'Tertahan — data belum lengkap', tone: 'warning' },
  SENT: { text: 'Terkirim', tone: 'success' },
  ERROR: { text: 'Ditolak SATUSEHAT', tone: 'danger' },
  DEAD: { text: 'Gagal setelah beberapa percobaan', tone: 'danger' },
  SKIPPED: { text: 'Tidak dikirim (pemrosesan dibatasi)', tone: 'neutral' },
};

const KIND: Record<string, string> = { prescription_item: 'Resep obat', dispense_line: 'Penyerahan obat', clinical_addendum: 'Koreksi diagnosis (addendum)' };
const FOLLOW = new Set(Object.keys(KIND));
const sentCount = (s: EncounterSyncStatus) => s.resources.filter((r) => r.status === 'SENT' && !r.enteredInError && r.localType !== 'clinical_addendum').length;
/** Tindak lanjut (batch 3) yang belum terkirim: resep, penyerahan obat, addendum diagnosis. */
const followUps = (s: EncounterSyncStatus) => s.resources.filter((r) => FOLLOW.has(r.localType) && r.status !== 'SENT');

/** Status pengiriman kunjungan ke SATUSEHAT (INT-FR-008). Hanya tampil bila fasilitas punya koneksi aktif. */
export function SatuSehatPanel({ encounterId, refreshKey }: { encounterId: string; refreshKey: string }) {
  const [s, setS] = useState<EncounterSyncStatus | null>(null);
  useEffect(() => {
    let live = true;
    api<EncounterSyncStatus>(`/encounters/${encounterId}/satusehat`).then((r) => { if (live) setS(r); }).catch(() => { if (live) setS(null); });
    return () => { live = false; };
  }, [encounterId, refreshKey]);
  if (!s?.configured || !s.status) return null;
  const l = LABEL[s.status] ?? { text: s.status, tone: 'info' as const };
  return (
    <div className="rounded-md border px-3 py-2 text-sm" data-testid="satusehat-status">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">SATUSEHAT</span>
        <Badge tone={l.tone}>{l.text}</Badge>
        {s.environment !== 'PRODUCTION' ? <span className="text-xs text-muted-foreground">({s.environment === 'SIMULATOR' ? 'simulator' : 'sandbox'})</span> : null}
        {s.status === 'SENT' && s.lastSentAt ? <span className="text-xs text-muted-foreground">{fmtDateTime(s.lastSentAt)} · {sentCount(s) + 1} data</span> : null}
        {s.status === 'PENDING' && s.nextAttemptAt ? <span className="text-xs text-muted-foreground">percobaan ke-{(s.attempts ?? 0) + 1} sekitar {fmtDateTime(s.nextAttemptAt)}</span> : null}
      </div>
      {s.blocking?.length ? <ul className="mt-1 list-disc pl-5 text-xs text-amber-800" data-testid="satusehat-blocking">{s.blocking.map((b) => <li key={b}>{b}</li>)}</ul> : null}
      {s.warnings?.length ? <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">{s.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
      {followUps(s).length ? (
        <ul className="mt-2 grid gap-1 border-t pt-2 text-xs" data-testid="satusehat-followups">
          {followUps(s).map((r) => (
            <li key={r.id} data-testid="satusehat-followup">
              <span className="font-medium">{KIND[r.localType] ?? r.resourceType}</span>: {LABEL[r.status]?.text ?? r.status}
              {[...r.blocking, ...(r.status === 'ERROR' || r.status === 'DEAD' ? [r.lastError ?? ''] : [])].filter(Boolean).map((b) => <div key={b} className="pl-3 text-amber-800">• {b}</div>)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
