'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import Link from 'next/link';
import { MasterSyncResult, SatuSehatEnvironment, SatuSehatIssue, SatuSehatOverview, api, errorText } from '../../../../lib/api';
import { fmtDateTime } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

const ENV_LABEL: Record<SatuSehatEnvironment, string> = { SIMULATOR: 'Simulator (uji lokal, bukan SATUSEHAT)', SANDBOX: 'Sandbox SATUSEHAT', PRODUCTION: 'Produksi SATUSEHAT' };
const LOC_LABEL: Record<string, string> = { PENDING: 'Belum dikirim', SENT: 'Terdaftar', ERROR: 'Gagal' };

/**
 * Integrasi SATUSEHAT (Stage 12 batch 1): kredensial per fasilitas (tersimpan terenkripsi, tidak ditampilkan lagi),
 * uji koneksi, sinkron master (Location per poli, IHS tenaga kesehatan), ringkasan IHS pasien.
 */
export default function SatuSehatPage() {
  const s = useSession();
  const manage = can(s, 'integration.manage');
  const [ov, setOv] = useState<SatuSehatOverview>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try { setOv(await api<SatuSehatOverview>('/integrations/satusehat')); setError(undefined); }
    catch (e) { setError(errorText(e, 'Gagal memuat integrasi SATUSEHAT')); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!ov) return error ? <Alert tone="error">{error}</Alert> : <p role="status" className="text-sm text-muted-foreground">Memuat…</p>;
  const id = ov.identity;
  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Integrasi SATUSEHAT</h1>
      <p className="text-sm text-muted-foreground">Data kunjungan dikirim ke platform SATUSEHAT Kementerian Kesehatan. Status integrasi resmi baru dapat dinyatakan setelah
        validasi di sandbox SATUSEHAT berhasil.</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="flex flex-wrap gap-x-8 gap-y-1 pt-6 text-sm" data-testid="ihs-summary">
          <span>Tenaga kesehatan ber-IHS: <b>{id.practitionersFound}</b> / {id.practitioners}</span>
          <span>Pasien terhubung: <b>{id.patientsFound}</b></span>
          <span>Belum dicari: <b>{id.patientsPending}</b></span>
          <span>NIK tidak ditemukan: <b>{id.patientsNotFound}</b></span>
          <span>Gagal dicari: <b>{id.patientsError}</b></span>
        </CardContent>
      </Card>
      {ov.facilities.map((f) => <FacilityCard key={f.facilityId} f={f} manage={manage} simulatorAllowed={ov.simulatorAllowed} onChanged={load} />)}
    </div>
  );
}

function FacilityCard({ f, manage, simulatorAllowed, onChanged }: { f: SatuSehatOverview['facilities'][number]; manage: boolean; simulatorAllowed: boolean; onChanged: () => Promise<void> }) {
  const c = f.connection;
  const [env, setEnv] = useState<SatuSehatEnvironment>(c?.environment ?? (simulatorAllowed ? 'SIMULATOR' : 'SANDBOX'));
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [orgId, setOrgId] = useState(c?.organizationId ?? '');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [sync, setSync] = useState<MasterSyncResult>();
  const envChanged = !!c && c.environment !== env;
  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key); setError(undefined); setNotice(undefined);
    try { setNotice(await fn()); await onChanged(); } catch (e) { setError(errorText(e, 'Gagal')); } finally { setBusy(undefined); }
  }
  function save(e: FormEvent) {
    e.preventDefault();
    if (envChanged && !window.confirm('Mengganti lingkungan akan mereset nomor IHS pasien dan tenaga kesehatan agar dicari ulang. Lanjutkan?')) return;
    void run('save', async () => {
      await api('/integrations/satusehat', { method: 'PUT', body: { facilityId: f.facilityId, environment: env, clientId: clientId.trim(),
        ...(secret ? { clientSecret: secret } : {}), organizationId: orgId.trim() } });
      setSecret(''); setClientId('');
      return 'Kredensial disimpan.';
    });
  }
  return (
    <Card data-testid="satusehat-facility">
      <CardHeader>
        <CardTitle>{f.facilityName}</CardTitle>
        <CardDescription>{c ? <>{ENV_LABEL[c.environment]} · Organization {c.organizationId} · client {c.clientIdMasked}</> : 'Belum terhubung.'}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {c?.lastTestAt ? (
          <p data-testid="connection-test"><Badge tone={c.lastTestOk ? 'success' : 'danger'}>{c.lastTestOk ? 'Terhubung' : 'Gagal'}</Badge>{' '}
            {c.lastTestMessage} <span className="text-xs text-muted-foreground">({fmtDateTime(c.lastTestAt)})</span></p>
        ) : null}
        {manage ? (
          <form className="grid gap-3 md:grid-cols-2" onSubmit={save}>
            <Field id={`env-${f.facilityId}`} label="Lingkungan">
              <Select id={`env-${f.facilityId}`} value={env} onChange={(e) => setEnv(e.target.value as SatuSehatEnvironment)}>
                {(['SIMULATOR', 'SANDBOX', 'PRODUCTION'] as const).filter((x) => x !== 'SIMULATOR' || simulatorAllowed).map((x) => <option key={x} value={x}>{ENV_LABEL[x]}</option>)}
              </Select>
            </Field>
            <Field id={`org-${f.facilityId}`} label="Organization ID" hint="Dari portal SATUSEHAT untuk fasyankes ini.">
              <Input id={`org-${f.facilityId}`} required minLength={3} value={orgId} onChange={(e) => setOrgId(e.target.value)} />
            </Field>
            <Field id={`cid-${f.facilityId}`} label="Client ID" hint={c ? 'Isi ulang untuk menyimpan perubahan.' : undefined}>
              <Input id={`cid-${f.facilityId}`} required minLength={3} autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} />
            </Field>
            <Field id={`sec-${f.facilityId}`} label="Client secret" hint={c?.hasSecret && !envChanged ? 'Tersimpan — kosongkan bila tidak diganti.' : 'Wajib diisi.'}>
              <Input id={`sec-${f.facilityId}`} type="password" autoComplete="new-password" required={!c?.hasSecret || envChanged} value={secret}
                onChange={(e) => setSecret(e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2 md:col-span-2">
              <Button type="submit" disabled={!!busy}>Simpan kredensial</Button>
              {c ? <>
                <Button type="button" variant="outline" disabled={!!busy} onClick={() => void run('test', async () => {
                  const r = await api<{ ok: boolean; message: string }>('/integrations/satusehat/test', { method: 'POST', body: { facilityId: f.facilityId } });
                  if (!r.ok) throw new Error(r.message);
                  return r.message;
                })}>Uji koneksi</Button>
                <Button type="button" variant="outline" disabled={!!busy} onClick={() => void run('sync', async () => {
                  const r = await api<MasterSyncResult>('/integrations/satusehat/sync-master', { method: 'POST', body: { facilityId: f.facilityId } });
                  setSync(r);
                  return 'Sinkron master selesai.';
                })}>Sinkron master</Button>
              </> : null}
            </div>
          </form>
        ) : null}
        {sync ? (
          <p className="text-xs" data-testid="sync-result">Location: {sync.locations.created} dibuat, {sync.locations.existing} sudah ada, {sync.locations.failed} gagal ·
            Tenaga kesehatan: {sync.practitioners.found} ditemukan, {sync.practitioners.notFound} tidak ditemukan, {sync.practitioners.noNik} tanpa NIK, {sync.practitioners.failed} gagal</p>
        ) : null}
        <Table>
          <THead><TR><TH>Poli / ruang</TH><TH>Cabang</TH><TH>Location SATUSEHAT</TH></TR></THead>
          <TBody>
            {f.locations.map((l) => (
              <TR key={l.unitId} data-testid="location-row">
                <TD>{l.unitName}</TD><TD>{l.branchName}</TD>
                <TD><Badge tone={l.status === 'SENT' ? 'success' : l.status === 'ERROR' ? 'danger' : 'neutral'}>{LOC_LABEL[l.status] ?? l.status}</Badge>
                  {l.locationId ? <span className="ml-2 font-mono text-xs">{l.locationId}</span> : null}
                  {l.lastError ? <span className="block text-xs text-muted-foreground">{l.lastError}</span> : null}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {c ? <IssueList facilityId={f.facilityId} manage={manage} /> : null}
      </CardContent>
    </Card>
  );
}

const ISSUE_LABEL: Record<string, { text: string; tone: 'warning' | 'danger' }> = {
  DEAD: { text: 'Gagal setelah beberapa percobaan', tone: 'danger' }, ERROR: { text: 'Ditolak SATUSEHAT', tone: 'danger' },
  BLOCKED: { text: 'Tertahan — data belum lengkap', tone: 'warning' },
};
const KIND_LABEL: Record<string, string> = { encounter: 'Kunjungan', prescription_item: 'Resep obat', dispense_line: 'Penyerahan obat', clinical_addendum: 'Koreksi diagnosis' };

/**
 * Perlu tindakan (OD-119, INT-FR-009): kiriman gagal/ditolak dapat dikirim ulang (teraudit, tanpa data ganda); yang tertahan
 * dicek ulang otomatis setelah data dilengkapi. Tanpa nama pasien.
 */
function IssueList({ facilityId, manage }: { facilityId: string; manage: boolean }) {
  const [items, setItems] = useState<SatuSehatIssue[]>();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      const r = await api<{ data: SatuSehatIssue[]; counts: Record<string, number> }>(`/integrations/satusehat/records?facilityId=${facilityId}`);
      setItems(r.data); setCounts(r.counts);
    } catch (e) { setError(errorText(e, 'Gagal memuat daftar kiriman')); }
  }, [facilityId]);
  useEffect(() => { void load(); }, [load]);
  async function retry(it: SatuSehatIssue) {
    try {
      const r = await api<{ alreadyQueued: boolean }>(`/integrations/satusehat/records/${it.id}/retry`, { method: 'POST' });
      setNotice(r.alreadyQueued ? 'Sudah dijadwalkan.' : 'Dijadwalkan dikirim ulang pada putaran berikutnya (± 5 menit).'); setError(undefined);
      await load();
    } catch (e) { setError(errorText(e, 'Gagal menjadwalkan kirim ulang')); }
  }
  if (!items) return null;
  return (
    <div className="grid gap-2 border-t pt-3" data-testid="satusehat-issues">
      <div className="flex flex-wrap items-center gap-2">
        <b>Perlu tindakan</b>
        <span className="text-xs text-muted-foreground" data-testid="issue-counts">Gagal {counts['DEAD'] ?? 0} · Ditolak {counts['ERROR'] ?? 0} · Tertahan {counts['BLOCKED'] ?? 0}</span>
      </div>
      {notice ? <p role="status" className="text-sm text-green-700">{notice}</p> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {items.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada kiriman yang perlu ditindaklanjuti.</p> : (
        <Table>
          <THead><TR><TH>Data</TH><TH>Kunjungan</TH><TH>Status</TH><TH>Keterangan</TH>{manage ? <TH /> : null}</TR></THead>
          <TBody>
            {items.map((it) => (
              <TR key={it.id} data-testid="issue-row">
                <TD>{KIND_LABEL[it.localType] ?? it.resourceType}</TD>
                <TD>{it.encounterId ? <Link className="underline" href={`/encounters/${it.encounterId}`}>{it.encounterNo}</Link> : '—'}</TD>
                <TD><Badge tone={ISSUE_LABEL[it.status].tone}>{ISSUE_LABEL[it.status].text}</Badge>
                  {it.status !== 'BLOCKED' ? <span className="block text-xs text-muted-foreground">{it.attempts}× dicoba · {fmtDateTime(it.updatedAt)}</span> : null}</TD>
                <TD className="text-xs">{[...it.blocking, ...(it.status !== 'BLOCKED' && it.lastError && !it.blocking.includes(it.lastError) ? [it.lastError] : [])].map((b) => <div key={b}>{b}</div>)}</TD>
                {manage ? <TD className="text-right">{it.resendable ? <Button size="sm" variant="outline" onClick={() => void retry(it)}>Kirim ulang</Button> : null}</TD> : null}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
