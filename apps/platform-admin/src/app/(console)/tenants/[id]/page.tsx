'use client';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, Field, Input, Select, Switch, Textarea,
} from '@clinicrme/ui';
import { ApiError, SupportGrant, Tenant, TenantStatus, api } from '../../../../lib/api';
import { GrantBadge, GrantSummary, RequestAccessForm } from '../../../../lib/support';
import { useRouter } from 'next/navigation';
import { STATUS_EFFECT, STATUS_LABEL, STATUS_TONE, TENANT_TYPE_LABEL, fmtDate } from '../../../../lib/labels';
import { can, useMe } from '../../../../lib/session';

const FEATURE = /^[a-z][a-z0-9_.-]{1,63}$/;

function TenantDetail() {
  const { id } = useParams<{ id: string }>();
  const created = useSearchParams().get('created');
  const me = useMe();
  const manage = can(me, 'platform.tenant.manage');
  const [t, setT] = useState<Tenant>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(() => api<Tenant>(`/tenants/${id}`).then(setT).catch((e) =>
    setError(e instanceof ApiError ? e.message : 'Gagal memuat tenant')), [id]);
  useEffect(() => { void load(); }, [load]);

  if (error && !t) return <Alert tone="error">{error}</Alert>;
  if (!t) return <p className="text-sm text-muted-foreground" role="status">Memuat…</p>;

  return (
    <div className="grid gap-4">
      <Link href="/tenants" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />Semua tenant
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{t.displayName}</h1>
        <Badge tone={STATUS_TONE[t.status]} data-testid="tenant-status">{STATUS_LABEL[t.status]}</Badge>
      </div>
      {created ? (
        <Alert tone="success">
          Tenant dibuat. Undangan admin klinik untuk <strong>{created}</strong> berlaku 7 hari: admin klinik masuk di alamat klinik
          dengan akun Google memakai email tersebut. Email undangan dikirim otomatis.
        </Alert>
      ) : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Informasi</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Kode</dt><dd className="font-mono">{t.code}</dd>
              <dt className="text-muted-foreground">Nama badan usaha</dt><dd>{t.legalName}</dd>
              <dt className="text-muted-foreground">Jenis</dt><dd>{TENANT_TYPE_LABEL[t.tenantType] ?? t.tenantType}</dd>
              <dt className="text-muted-foreground">Paket</dt>
              <dd>{t.plan ? `${t.plan.code} — maks. ${t.plan.maxUsers} user aktif, ${t.plan.maxBranches} cabang` : 'Tanpa langganan'}</dd>
              <dt className="text-muted-foreground">Trial berakhir</dt><dd>{fmtDate(t.trialEndsAt)}</dd>
              <dt className="text-muted-foreground">Dibuat</dt><dd>{fmtDate(t.createdAt)}</dd>
            </dl>
          </CardContent>
        </Card>
        <StatusCard tenant={t} manage={manage} onChanged={(nt, msg) => { setT(nt); setNotice(msg); setError(undefined); }} onError={setError} />
      </div>
      <FlagsCard tenant={t} manage={manage} onChanged={load} onError={setError} />
      <SupportCard tenant={t} />
    </div>
  );
}

function StatusCard({ tenant, manage, onChanged, onError }: {
  tenant: Tenant; manage: boolean; onChanged: (t: Tenant, msg: string) => void; onError: (m: string) => void;
}) {
  const allowed = tenant.allowedTransitions ?? [];
  const [to, setTo] = useState<TenantStatus | ''>('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTo(''); setReason(''); }, [tenant.status]);

  async function submit() {
    if (!to) return;
    setBusy(true);
    try {
      const nt = await api<Tenant>(`/tenants/${tenant.id}/status`, { method: 'POST', body: { status: to, reason: reason.trim() } });
      setConfirm(false);
      onChanged(nt, `Status diubah menjadi ${STATUS_LABEL[nt.status]}.`);
    } catch (e) {
      setConfirm(false);
      onError(e instanceof ApiError ? e.message : 'Gagal mengubah status');
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Status</CardTitle>
        <CardDescription>Setiap perubahan wajib beralasan dan tercatat di histori serta audit klinik.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!manage ? <p className="text-sm text-muted-foreground">Hanya admin platform yang dapat mengubah status.</p>
          : allowed.length === 0 ? <p className="text-sm text-muted-foreground">Status final — tidak ada perubahan yang diizinkan.</p> : (
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); setConfirm(true); }}>
            <Field id="to" label="Ubah menjadi">
              <Select id="to" value={to} onChange={(e) => setTo(e.target.value as TenantStatus)} required>
                <option value="" disabled>Pilih status…</option>
                {allowed.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </Select>
            </Field>
            {to && STATUS_EFFECT[to] ? <p className="text-xs text-muted-foreground">{STATUS_EFFECT[to]}</p> : null}
            <Field id="reason" label="Alasan">
              <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
                        placeholder="mis. Invoice November belum dibayar setelah 3 pengingat" required />
            </Field>
            <Button type="submit" variant={to === 'SUSPENDED' || to === 'TERMINATED' ? 'destructive' : 'default'}
                    disabled={!to || reason.trim().length < 3}>Ubah status</Button>
          </form>
        )}
      </CardContent>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={to ? `Ubah status ke ${STATUS_LABEL[to]}?` : ''}
              description={`${tenant.displayName} (${tenant.code})`}>
        {to && STATUS_EFFECT[to] ? <Alert tone={to === 'TERMINATED' || to === 'SUSPENDED' ? 'error' : 'info'}>{STATUS_EFFECT[to]}</Alert> : null}
        <p className="text-sm"><span className="text-muted-foreground">Alasan:</span> {reason}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirm(false)}>Batal</Button>
          <Button variant={to === 'TERMINATED' || to === 'SUSPENDED' ? 'destructive' : 'default'} loading={busy} onClick={submit}>
            Ya, ubah status
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

function FlagsCard({ tenant, manage, onChanged, onError }: {
  tenant: Tenant; manage: boolean; onChanged: () => void; onError: (m: string) => void;
}) {
  const flags = Object.entries(tenant.featureFlags ?? {});
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<string>();

  async function set(feature: string, enabled: boolean) {
    setBusy(feature);
    try {
      await api(`/tenants/${tenant.id}/feature-flags/${encodeURIComponent(feature)}`, { method: 'PUT', body: { enabled } });
      onChanged();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Gagal mengubah fitur');
    } finally { setBusy(undefined); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Feature flag</CardTitle>
        <CardDescription>Mengaktifkan fitur bertahap per klinik (PLT-FR-011).</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {flags.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada feature flag.</p> : (
          <ul className="divide-y rounded-md border">
            {flags.map(([f, on]) => (
              <li key={f} className="flex items-center justify-between px-3 py-2 text-sm">
                <label htmlFor={`flag-${f}`} className="font-mono">{f}</label>
                <Switch id={`flag-${f}`} checked={on} disabled={!manage || busy === f} onChange={(e) => set(f, e.target.checked)} />
              </li>
            ))}
          </ul>
        )}
        {manage ? (
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (FEATURE.test(code)) { void set(code, true); setCode(''); } }}>
            <div className="grow">
              <Field id="new-flag" label="Tambah fitur" hint="Huruf kecil, angka, titik, minus, garis bawah (mis. pharmacy.v2).">
                <Input id="new-flag" value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} placeholder="pharmacy.v2" />
              </Field>
            </div>
            <Button type="submit" variant="outline" disabled={!FEATURE.test(code)} className="mb-5">Aktifkan</Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Break-glass (PLT-FR-009): support meminta akses; admin platform melihat & dapat mencabut lewat halaman akses. */
function SupportCard({ tenant }: { tenant: Tenant }) {
  const me = useMe();
  const router = useRouter();
  const support = can(me, 'platform.support.access');
  const [grants, setGrants] = useState<SupportGrant[]>();
  useEffect(() => {
    api<SupportGrant[]>(`/support-access?tenantId=${tenant.id}`).then(setGrants).catch(() => setGrants([]));
  }, [tenant.id]);
  const mineActive = grants?.find((g) => g.active && g.platformUserId === me.id);
  const supportable = !['PROVISIONING', 'TERMINATED'].includes(tenant.status);
  if (!support && !grants?.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Akses dukungan</CardTitle>
        <CardDescription>Akses baca sementara untuk staf support (maks. 8 jam), diberitahukan ke semua admin klinik lewat email.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {support && mineActive ? (
          <Alert tone="info">
            Akses Anda aktif sampai {new Date(mineActive.expiresAt).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })} WIB.{' '}
            <Link href={`/support/${mineActive.id}`} className="font-medium underline">Buka data dukungan</Link>
          </Alert>
        ) : support && supportable ? (
          <RequestAccessForm tenantId={tenant.id} tenantName={`${tenant.displayName} (${tenant.code})`} onGranted={(g) => router.push(`/support/${g.id}`)} />
        ) : support ? <p className="text-sm text-muted-foreground">Tenant dengan status ini tidak dapat diberi akses dukungan.</p> : null}
        {grants && grants.length ? (
          <ul className="divide-y rounded-md border">
            {grants.slice(0, 5).map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 px-3 py-2"><GrantSummary g={g} /><GrantBadge g={g} /></li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function TenantDetailPage() {
  return <Suspense><TenantDetail /></Suspense>;
}
