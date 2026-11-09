'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Input } from '@clinicrme/ui';
import { Substitution, api, errorText } from '../../../lib/api';
import { fmtDateTime } from '../../../lib/format';

const STATUS_LABEL: Record<Substitution['status'], string> = { REQUESTED: 'Menunggu', APPROVED: 'Disetujui', REJECTED: 'Ditolak', CANCELLED: 'Dibatalkan' };

/**
 * Persetujuan substitusi obat untuk dokter (PHM-FR-010; OD-099): pengajuan apoteker untuk resep yang Anda tulis, atau di
 * cabang tempat Anda bertugas hari ini (DEC-013/OD-064). Peringatan alergi pasien terhadap obat pengganti ditampilkan.
 */
export default function SubstitutionsPage() {
  const [tab, setTab] = useState<'REQUESTED' | 'DECIDED'>('REQUESTED');
  const [items, setItems] = useState<Substitution[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const load = useCallback(async () => {
    try { setItems(await api<Substitution[]>(`/substitutions?status=${tab}`)); setError(undefined); } catch (e) { setError(errorText(e, 'Gagal memuat pengajuan')); }
  }, [tab]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Persetujuan substitusi</h1>
        <div className="flex gap-1" role="tablist">
          <Button role="tab" aria-selected={tab === 'REQUESTED'} size="sm" variant={tab === 'REQUESTED' ? 'default' : 'outline'} onClick={() => setTab('REQUESTED')}>Menunggu</Button>
          <Button role="tab" aria-selected={tab === 'DECIDED'} size="sm" variant={tab === 'DECIDED' ? 'default' : 'outline'} onClick={() => setTab('DECIDED')}>Riwayat 30 hari</Button>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()}>Muat ulang</Button>
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada pengajuan.</p> : (
        <div className="grid gap-3">
          {items.map((s) => <Item key={s.id} s={s} onDone={async (msg) => { setNotice(msg); await load(); }} />)}
        </div>
      )}
    </div>
  );
}

function Item({ s, onDone }: { s: Substitution; onDone: (msg: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function decide(decision: 'APPROVE' | 'REJECT') {
    setBusy(true); setError(undefined);
    try {
      await api(`/substitutions/${s.id}/decision`, { method: 'POST', body: { decision, note: note.trim() || null } });
      await onDone(decision === 'APPROVE' ? `Substitusi ${s.fromDrug.name} → ${s.toDrug.name} disetujui.` : 'Substitusi ditolak.');
    } catch (e) { setError(errorText(e, 'Gagal menyimpan keputusan')); } finally { setBusy(false); }
  }
  return (
    <Card data-testid="substitution-card">
      <CardContent className="grid gap-2 pt-6 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <strong>{s.patient.name}</strong><span className="text-xs text-muted-foreground">RM {s.patient.mrn} · {s.prescription.prescriptionNo} · {s.prescription.branchName}</span>
          <Badge tone={s.status === 'REQUESTED' ? 'warning' : s.status === 'APPROVED' ? 'success' : 'neutral'} className="ml-auto">{STATUS_LABEL[s.status]}</Badge>
        </div>
        <p>Baris {s.item.lineNo}: <span className="line-through">{s.fromDrug.name}</span> → <strong>{s.toDrug.name}{s.toDrug.strength ? ` ${s.toDrug.strength}` : ''}</strong>
          {' '}· {s.item.qty} {s.item.uomName} · {s.item.frequency}</p>
        <p className="text-xs">Alasan apoteker: {s.reason} — {s.requestedByName}, {fmtDateTime(s.requestedAt)}</p>
        <p className="text-xs text-muted-foreground">Dokter penulis resep: {s.prescription.prescriberName}</p>
        {s.allergyWarnings.length ? <Alert tone="error">Pasien tercatat alergi: {s.allergyWarnings.join(', ')} — kandungan obat pengganti cocok.</Alert> : null}
        {s.decidedAt ? <p className="text-xs">Diputuskan {s.decidedByName} · {fmtDateTime(s.decidedAt)}{s.decisionNote ? ` · ${s.decisionNote}` : ''}</p> : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {s.status === 'REQUESTED' ? (
          <div className="flex flex-wrap items-center gap-2">
            {rejecting ? <Input aria-label="Alasan penolakan" placeholder="Alasan penolakan (wajib)" className="w-72" value={note} onChange={(e) => setNote(e.target.value)} /> : null}
            {rejecting ? (
              <>
                <Button size="sm" variant="outline" onClick={() => setRejecting(false)}>Batal</Button>
                <Button size="sm" variant="destructive" disabled={note.trim().length < 5 || busy} onClick={() => void decide('REJECT')}>Kirim penolakan</Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>Tolak</Button>
                <Button size="sm" disabled={busy} onClick={() => void decide('APPROVE')}>Setujui</Button>
              </>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
