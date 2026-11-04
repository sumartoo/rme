'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Badge, Button, Dialog, Field, Select, Textarea } from '@clinicrme/ui';
import { ApiError, SupportGrant, api } from './api';
import { SUPPORT_DURATIONS, fmtDateTime } from './labels';

export function GrantBadge({ g }: { g: SupportGrant }) {
  if (g.revokedAt) return <Badge tone="neutral">Dicabut</Badge>;
  return g.active ? <Badge tone="warning">Aktif</Badge> : <Badge tone="neutral">Kedaluwarsa</Badge>;
}

/** Form minta akses dukungan: alasan ≥ 10 karakter, durasi 15 menit – 8 jam. Konfirmasi menjelaskan dampaknya. */
export function RequestAccessForm({ tenantId, tenantName, onGranted }: { tenantId: string; tenantName: string; onGranted: (g: SupportGrant) => void }) {
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ok = reason.trim().length >= 10;

  async function submit() {
    setBusy(true); setError(undefined);
    try {
      const g = await api<SupportGrant>('/support-access', { method: 'POST', body: { tenantId, reason: reason.trim(), durationMinutes: minutes } });
      setConfirm(false); setReason('');
      onGranted(g);
    } catch (e) {
      setConfirm(false);
      setError(e instanceof ApiError ? e.message : 'Gagal meminta akses');
    } finally { setBusy(false); }
  }

  return (
    <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (ok) setConfirm(true); }}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field id="support-reason" label="Alasan" hint="Minimal 10 karakter, mis. nomor tiket dan masalahnya. Dikirim ke semua admin klinik.">
        <Textarea id="support-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
                  placeholder="Tiket #123: admin klinik tidak bisa login" />
      </Field>
      <Field id="support-duration" label="Durasi">
        <Select id="support-duration" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {SUPPORT_DURATIONS.map((d) => <option key={d.minutes} value={d.minutes}>{d.label}</option>)}
        </Select>
      </Field>
      <Button type="submit" variant="outline" disabled={!ok}>Minta akses dukungan</Button>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Buka akses dukungan?" description={tenantName}>
        <Alert tone="info">
          Semua admin klinik akan menerima email berisi alasan dan masa berlaku. Anda hanya dapat membaca daftar user/role dan
          log audit klinik; data pasien &amp; rekam medis tidak dapat dibuka. Setiap pembacaan tercatat di log audit klinik.
        </Alert>
        <p className="text-sm"><span className="text-muted-foreground">Alasan:</span> {reason}</p>
        <p className="text-sm"><span className="text-muted-foreground">Durasi:</span> {SUPPORT_DURATIONS.find((d) => d.minutes === minutes)?.label}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirm(false)}>Batal</Button>
          <Button loading={busy} onClick={submit}>Ya, buka akses</Button>
        </div>
      </Dialog>
    </form>
  );
}

export function GrantSummary({ g }: { g: SupportGrant }) {
  return (
    <span className="grid gap-0.5 text-sm">
      <Link href={`/support/${g.id}`} className="font-medium hover:text-primary">{g.tenantCode} · {g.supportName}</Link>
      <span className="text-xs text-muted-foreground">{fmtDateTime(g.startsAt)} s.d. {fmtDateTime(g.expiresAt)}</span>
    </span>
  );
}
