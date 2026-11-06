'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, Field, Input, Textarea } from '@clinicrme/ui';
import { ApiError, EncounterChart, api, errorText } from '../../../../lib/api';
import { fmtDateTime } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

const MISSING_LABEL: Record<string, string> = {
  subjective: 'S — Subjektif', objective: 'O — Objektif', assessment: 'A — Asesmen', plan: 'P — Rencana', primaryDiagnosis: 'Diagnosis primer',
};
const METHOD_LABEL: Record<string, string> = { PASSWORD: 'kata sandi', TOTP: 'kode autentikator' };

/** Kata sandi ATAU kode autentikator 6 digit (OD-034). */
function Reauth({ value, onChange }: { value: { mode: 'PASSWORD' | 'TOTP'; secret: string }; onChange: (v: { mode: 'PASSWORD' | 'TOTP'; secret: string }) => void }) {
  return (
    <div className="grid gap-2">
      <div className="flex gap-4 text-sm" role="radiogroup" aria-label="Cara konfirmasi">
        <label className="flex items-center gap-1"><input type="radio" checked={value.mode === 'PASSWORD'} onChange={() => onChange({ mode: 'PASSWORD', secret: '' })} /> Kata sandi</label>
        <label className="flex items-center gap-1"><input type="radio" checked={value.mode === 'TOTP'} onChange={() => onChange({ mode: 'TOTP', secret: '' })} /> Kode autentikator</label>
      </div>
      {value.mode === 'PASSWORD' ? (
        <Field id="re-password" label="Kata sandi Anda"><Input id="re-password" type="password" autoComplete="current-password" value={value.secret} onChange={(e) => onChange({ ...value, secret: e.target.value })} /></Field>
      ) : (
        <Field id="re-code" label="Kode autentikator (6 digit)"><Input id="re-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={value.secret} onChange={(e) => onChange({ ...value, secret: e.target.value.replace(/\D/g, '') })} /></Field>
      )}
    </div>
  );
}
const reauthBody = (r: { mode: 'PASSWORD' | 'TOTP'; secret: string }) => (r.mode === 'PASSWORD' ? { password: r.secret } : { code: r.secret });
const reauthOk = (r: { mode: 'PASSWORD' | 'TOTP'; secret: string }) => (r.mode === 'PASSWORD' ? r.secret.length > 0 : /^\d{6}$/.test(r.secret));

/**
 * Pengesahan & addendum (CLN-FR-017–019; OD-034): tanda tangan elektronik tidak tersertifikasi — dokter mengonfirmasi
 * ulang dengan kata sandi atau kode autentikator; sistem menyimpan penandatangan, SIP, waktu, dan hash isi rekam medis.
 */
export function SignPanel({ chart, onSaved }: { chart: EncounterChart; onSaved: () => Promise<void> }) {
  const s = useSession();
  const [open, setOpen] = useState<'sign' | 'addendum'>();
  const [verify, setVerify] = useState<{ valid: boolean; addenda: { id: string; valid: boolean }[] }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<string>();
  const n = chart.note;
  const missing = [
    ...(['subjective', 'objective', 'assessment', 'plan'] as const).filter((k) => !n?.[k]?.trim()),
    ...(chart.diagnoses.some((d) => d.rank === 'PRIMER') ? [] : ['primaryDiagnosis']),
  ];
  const canSign = can(s, 'clinical.note.sign') && chart.editable && chart.encounter.status === 'IN_CONSULTATION';

  async function finish() {
    setBusy(true);
    try {
      const r = await api<{ status: string; prescriptionNo: string | null }>(`/encounters/${chart.encounter.id}/finish-consultation`, { method: 'POST' });
      setFinished(`Konsultasi selesai${r.prescriptionNo ? `, resep ${r.prescriptionNo} diterbitkan` : ''}. Pasien diteruskan ke ${r.status === 'PHARMACY' ? 'farmasi' : 'kasir'}.`);
      setError(undefined); await onSaved();
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'CLN-422-RX-ALERTS' ? 'Ada peringatan resep yang belum diberi alasan. Buka tab Resep, isi alasannya, lalu simpan resep.' : errorText(e, 'Gagal menyelesaikan konsultasi'));
    } finally { setBusy(false); }
  }

  async function check() {
    try { setVerify(await api(`/clinical-notes/${n!.id}/verify`)); setError(undefined); }
    catch (e) { setError(errorText(e, 'Gagal memeriksa integritas')); }
  }

  if (n?.status === 'SIGNED') {
    return (
      <Card data-testid="signed-panel">
        <CardHeader><CardTitle className="flex flex-wrap items-center gap-2">Rekam medis disahkan <Badge tone="success">Terkunci</Badge></CardTitle></CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <p>Oleh <b>{n.signedByName}</b>{n.signerSip ? ` (SIP ${n.signerSip})` : ''} · {fmtDateTime(n.signedAt)} · konfirmasi {METHOD_LABEL[n.signMethod ?? ''] ?? '—'}</p>
          {n.substituteReason ? <p className="text-muted-foreground">Sebagai dokter pengganti: {n.substituteReason}</p> : null}
          <p className="break-all font-mono text-xs text-muted-foreground">Hash: {n.contentHash}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void check()}>Periksa integritas</Button>
            {verify ? (
              <span data-testid="verify-result" className={verify.valid && verify.addenda.every((a) => a.valid) ? 'text-green-700' : 'font-medium text-destructive'}>
                {verify.valid && verify.addenda.every((a) => a.valid) ? '✓ Isi sesuai saat disahkan' : '⚠ Isi berbeda dari saat disahkan — laporkan ke admin klinik'}
              </span>
            ) : null}
            {can(s, 'clinical.note.addendum') ? <Button size="sm" variant="outline" className="ml-auto" onClick={() => setOpen('addendum')}>Tambah addendum</Button> : null}
          </div>
          {can(s, 'clinical.note.write') && chart.encounter.status === 'IN_CONSULTATION' ? (
            <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted/50 p-3">
              <span>{chart.prescription?.items.length ? `Resep ${chart.prescription.items.length} baris akan diterbitkan.` : 'Tanpa resep.'} Pasien diteruskan ke farmasi/kasir.</span>
              <Button className="ml-auto" loading={busy} onClick={() => void finish()}>Selesai konsultasi</Button>
            </div>
          ) : null}
          {finished ? <Alert tone="success" data-testid="finish-notice">{finished}</Alert> : null}
          <p className="text-xs text-muted-foreground">Tanda tangan elektronik tidak tersertifikasi (bukan PSrE).</p>
          {n.addenda.length ? (
            <div className="grid gap-2 border-t pt-3">
              <b>Addendum</b>
              {n.addenda.map((a) => (
                <div key={a.id} className="rounded-md border p-3" data-testid="addendum-row">
                  <p className="text-xs text-muted-foreground">{fmtDateTime(a.signedAt)} · {a.authorName}{a.authorSip ? ` (SIP ${a.authorSip})` : ''} · alasan: {a.reason}</p>
                  <p className="whitespace-pre-wrap">{a.content}</p>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
        {open === 'addendum' ? <AddendumDialog noteId={n.id} onClose={() => setOpen(undefined)} onDone={async () => { setOpen(undefined); setVerify(undefined); await onSaved(); }} /> : null}
      </Card>
    );
  }
  if (!canSign) return null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-4 py-3">
        <span className="text-sm">{missing.length ? `Belum lengkap untuk disahkan: ${missing.map((m) => MISSING_LABEL[m]).join(', ')}.` : 'Rekam medis lengkap dan siap disahkan.'}</span>
        <Button className="ml-auto" disabled={missing.length > 0} onClick={() => setOpen('sign')}>Sahkan rekam medis</Button>
      </div>
      {open === 'sign' ? <SignDialog chart={chart} onClose={() => setOpen(undefined)} onDone={async () => { setOpen(undefined); await onSaved(); }} /> : null}
    </>
  );
}

function SignDialog({ chart, onClose, onDone }: { chart: EncounterChart; onClose: () => void; onDone: () => Promise<void> }) {
  const [re, setRe] = useState<{ mode: 'PASSWORD' | 'TOTP'; secret: string }>({ mode: 'PASSWORD', secret: '' });
  const [substitute, setSubstitute] = useState('');
  const [needReason, setNeedReason] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api(`/encounters/${chart.encounter.id}/sign`, { method: 'POST', body: { ...reauthBody(re), ...(substitute.trim() ? { substituteReason: substitute.trim() } : {}) } });
      await onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CLN-400-SUBSTITUTE-REASON') setNeedReason(true);
      if (err instanceof ApiError && err.code === 'CLN-422-INCOMPLETE') setError(`Belum lengkap: ${((err.problem as { missing?: string[] }).missing ?? []).map((m) => MISSING_LABEL[m] ?? m).join(', ')}`);
      else setError(errorText(err, 'Gagal mengesahkan'));
      setRe((r) => ({ ...r, secret: '' }));
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title="Sahkan rekam medis" description={`${chart.patient.fullName} · ${chart.encounter.encounterNo}`}>
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p className="text-sm">Setelah disahkan, catatan SOAP, tanda vital, diagnosis, dan tindakan <b>terkunci</b>. Koreksi hanya lewat addendum.</p>
        <Reauth value={re} onChange={setRe} />
        <Field id="sub-reason" label={needReason ? 'Alasan sebagai dokter pengganti *' : 'Alasan sebagai dokter pengganti'}
               hint={needReason ? 'Anda bukan dokter kunjungan ini; alasan wajib diisi.' : 'Isi hanya bila Anda menggantikan dokter kunjungan.'}>
          <Textarea id="sub-reason" rows={2} maxLength={500} value={substitute} onChange={(e) => setSubstitute(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!reauthOk(re) || (needReason && substitute.trim().length < 5)}>Sahkan</Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddendumDialog({ noteId, onClose, onDone }: { noteId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [content, setContent] = useState('');
  const [re, setRe] = useState<{ mode: 'PASSWORD' | 'TOTP'; secret: string }>({ mode: 'PASSWORD', secret: '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api(`/clinical-notes/${noteId}/addenda`, { method: 'POST', body: { reason: reason.trim(), content: content.trim(), ...reauthBody(re) } });
      await onDone();
    } catch (err) { setError(errorText(err, 'Gagal menyimpan addendum')); setRe((r) => ({ ...r, secret: '' })); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title="Tambah addendum" description="Koreksi atau tambahan atas catatan yang sudah disahkan. Catatan asli tidak berubah.">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="ad-reason" label="Alasan *"><Input id="ad-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Field id="ad-content" label="Isi addendum *"><Textarea id="ad-content" rows={4} maxLength={10_000} value={content} onChange={(e) => setContent(e.target.value)} /></Field>
        <Reauth value={re} onChange={setRe} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={reason.trim().length < 5 || !content.trim() || !reauthOk(re)}>Simpan addendum</Button>
        </div>
      </form>
    </Dialog>
  );
}
