'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { SatuSehatOverview, api, errorText } from '../../../../../lib/api';

interface Summary { configured: boolean; environment: string | null; timezone: string; queued: number; duplicates: number; unchecked: number;
  data: { date: string; sent: number; pending: number; blocked: number; error: number; dead: number; skipped: number }[]; totals: Record<string, number> }
interface Recon { from: string; to: string; timezone: string;
  summary: { signed: number; sent: number; skipped: number; notSent: number; idMismatch: number; difference: number; remoteUnchecked: number; duplicates: number;
    openFollowUps: number; missingIds: number };
  data: { encounterId: string; encounterNo: string; signedOn: string; status: string; reason: string; remoteChecked: boolean }[] }

const STATUS: Record<string, { text: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  QUEUED: { text: 'Antrean', tone: 'info' }, PENDING: { text: 'Dicoba ulang', tone: 'warning' }, BLOCKED: { text: 'Tertahan', tone: 'warning' },
  SENT: { text: 'Terkirim', tone: 'success' }, ERROR: { text: 'Ditolak', tone: 'danger' }, DEAD: { text: 'Gagal', tone: 'danger' }, SKIPPED: { text: 'Tidak dikirim', tone: 'neutral' },
};
const fmtDay = (d: string) => new Intl.DateTimeFormat('id-ID', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

/**
 * Pemantauan SATUSEHAT (Stage 12 batch 4): dashboard terkirim/tertunda/gagal per hari (INT-FR-010) dan rekonsiliasi kunjungan disahkan
 * vs terkirim (INT-FR-011). Tanpa nama pasien — hanya nomor kunjungan & status.
 */
export default function SatuSehatMonitoringPage() {
  const [ov, setOv] = useState<SatuSehatOverview>();
  const [facilityId, setFacilityId] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api<SatuSehatOverview>('/integrations/satusehat').then((o) => {
      setOv(o);
      setFacilityId((o.facilities.find((f) => f.connection) ?? o.facilities[0])?.facilityId);
    }).catch((e) => setError(errorText(e, 'Gagal memuat fasilitas')));
  }, []);
  if (!ov) return error ? <Alert tone="error">{error}</Alert> : <p role="status" className="text-sm text-muted-foreground">Memuat…</p>;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Pemantauan SATUSEHAT</h1>
          <p className="text-sm text-muted-foreground">Jumlah kiriman per hari dan rekonsiliasi kunjungan yang sudah disahkan. Tindak lanjut kiriman gagal ada di{' '}
            <Link className="underline" href="/integrations/satusehat">Integrasi › SATUSEHAT</Link>.</p>
        </div>
        {ov.facilities.length > 1 ? (
          <Field id="mon-facility" label="Fasilitas">
            <Select id="mon-facility" value={facilityId} onChange={(e) => setFacilityId(e.target.value)}>
              {ov.facilities.map((f) => <option key={f.facilityId} value={f.facilityId}>{f.facilityName}</option>)}
            </Select>
          </Field>
        ) : null}
      </div>
      {facilityId ? <Dashboard key={`d-${facilityId}`} facilityId={facilityId} /> : null}
      {facilityId ? <Reconciliation key={`r-${facilityId}`} facilityId={facilityId} /> : null}
    </div>
  );
}

function Dashboard({ facilityId }: { facilityId: string }) {
  const [s, setS] = useState<Summary>();
  const [days, setDays] = useState('14');
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try { setS(await api<Summary>(`/integrations/satusehat/summary?facilityId=${facilityId}&days=${days}`)); setError(undefined); }
    catch (e) { setError(errorText(e, 'Gagal memuat ringkasan')); }
  }, [facilityId, days]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!s) return null;
  if (!s.configured) return <Alert tone="info">Koneksi SATUSEHAT untuk fasilitas ini belum dikonfigurasi.</Alert>;
  const t = s.totals;
  const tiles: [string, number, string][] = [
    ['Terkirim', t['SENT'] ?? 0, 'sent'], ['Antrean', s.queued, 'queued'], ['Dicoba ulang', t['PENDING'] ?? 0, 'pending'], ['Tertahan', t['BLOCKED'] ?? 0, 'blocked'],
    ['Ditolak', t['ERROR'] ?? 0, 'error'], ['Gagal', t['DEAD'] ?? 0, 'dead'], ['Data ganda di SATUSEHAT', s.duplicates, 'duplicates'],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Dashboard pengiriman{s.environment !== 'PRODUCTION' ? <span className="ml-2 text-sm font-normal text-muted-foreground">({s.environment === 'SIMULATOR' ? 'simulator' : 'sandbox'})</span> : null}</CardTitle>
        <CardDescription>Total saat ini per status (kunjungan, resep, penyerahan obat, koreksi diagnosis). Per hari dikelompokkan pada aktivitas terakhir, zona waktu {s.timezone}.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7" data-testid="sync-totals">
          {tiles.map(([label, n, k]) => (
            <div key={k} className="rounded-md border p-3" data-testid={`tile-${k}`}>
              <dt className="text-xs text-muted-foreground">{label}</dt><dd className="text-2xl font-semibold tabular-nums">{n}</dd>
            </div>
          ))}
        </dl>
        {s.unchecked ? <p className="text-xs text-muted-foreground">{s.unchecked} kunjungan terkirim menunggu pencocokan otomatis dengan SATUSEHAT (tiap jam).</p> : null}
        <div className="flex items-end gap-2">
          <Field id="mon-days" label="Rentang">
            <Select id="mon-days" value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="7">7 hari</option><option value="14">14 hari</option><option value="30">30 hari</option><option value="90">90 hari</option>
            </Select>
          </Field>
        </div>
        <Table data-testid="sync-daily">
          <THead><TR><TH>Tanggal</TH><TH className="text-right">Terkirim</TH><TH className="text-right">Dicoba ulang</TH><TH className="text-right">Tertahan</TH>
            <TH className="text-right">Ditolak</TH><TH className="text-right">Gagal</TH><TH className="text-right">Tidak dikirim</TH></TR></THead>
          <TBody>
            {s.data.map((d) => (
              <TR key={d.date} data-testid="sync-day">
                <TD>{fmtDay(d.date)}</TD><TD className="text-right tabular-nums">{d.sent}</TD><TD className="text-right tabular-nums">{d.pending}</TD>
                <TD className="text-right tabular-nums">{d.blocked}</TD><TD className="text-right tabular-nums">{d.error}</TD><TD className="text-right tabular-nums">{d.dead}</TD>
                <TD className="text-right tabular-nums">{d.skipped}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Reconciliation({ facilityId }: { facilityId: string }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [r, setR] = useState<Recon>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (f?: string, t?: string) => {
    setBusy(true);
    try {
      const q = new URLSearchParams({ facilityId, ...(f ? { from: f } : {}), ...(t ? { to: t } : {}) });
      const res = await api<Recon>(`/integrations/satusehat/reconciliation?${q}`);
      setR(res); setFrom(res.from); setTo(res.to); setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal menjalankan rekonsiliasi')); } finally { setBusy(false); }
  }, [facilityId]);
  useEffect(() => { void load(); }, [load]);
  function submit(e: FormEvent) { e.preventDefault(); void load(from, to); }
  const m = r?.summary;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Rekonsiliasi</CardTitle>
        <CardDescription>Kunjungan yang disahkan pada rentang tanggal dibandingkan dengan yang tercatat terkirim ke SATUSEHAT (maks. 92 hari).</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
          <Field id="rc-from" label="Dari"><Input id="rc-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field id="rc-to" label="Sampai"><Input id="rc-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Button type="submit" loading={busy}>Tampilkan</Button>
        </form>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {m ? (
          <>
            <p className="text-sm" data-testid="recon-summary">
              Disahkan <b>{m.signed}</b> · Terkirim <b>{m.sent}</b> · Tidak dikirim (dibatasi pasien) <b>{m.skipped}</b> · Belum terkirim <b>{m.notSent}</b>
              {m.idMismatch ? <> · ID tidak cocok <b>{m.idMismatch}</b></> : null} · <span data-testid="recon-difference">Selisih <b>{m.difference}</b></span>
            </p>
            {m.duplicates || m.openFollowUps || m.missingIds || m.remoteUnchecked ? (
              <p className="text-xs text-muted-foreground">Data ganda di SATUSEHAT {m.duplicates} · Obat/koreksi belum terkirim {m.openFollowUps} · ID belum diketahui {m.missingIds} ·
                Menunggu pencocokan {m.remoteUnchecked}</p>
            ) : null}
            {r.data.length === 0 ? <p className="text-sm text-muted-foreground">Semua kunjungan yang disahkan pada rentang ini sudah terkirim dan cocok.</p> : (
              <Table data-testid="recon-rows">
                <THead><TR><TH>Kunjungan</TH><TH>Disahkan</TH><TH>Status</TH><TH>Keterangan</TH></TR></THead>
                <TBody>
                  {r.data.map((x) => (
                    <TR key={x.encounterId} data-testid="recon-row">
                      <TD><Link className="underline" href={`/encounters/${x.encounterId}`}>{x.encounterNo}</Link></TD>
                      <TD>{fmtDay(x.signedOn)}</TD>
                      <TD><Badge tone={STATUS[x.status]?.tone ?? 'neutral'}>{STATUS[x.status]?.text ?? x.status}</Badge></TD>
                      <TD className="text-xs">{x.reason}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
