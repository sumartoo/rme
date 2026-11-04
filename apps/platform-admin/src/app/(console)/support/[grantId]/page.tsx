'use client';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, TBody, TD, TH, THead, TR, Table,
} from '@clinicrme/ui';
import { ApiError, Page, SupportAuditEntry, SupportGrant, SupportUser, api } from '../../../../lib/api';
import { ACTOR_KIND_LABEL, fmtDateTime } from '../../../../lib/labels';
import { can, useMe } from '../../../../lib/session';
import { GrantBadge } from '../../../../lib/support';

const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/**
 * Satu akses dukungan. Pemiliknya (support) membaca user/role & log audit tenant — setiap pembacaan diaudit di klinik
 * dan ditolak database bila akses sudah berakhir. Admin platform hanya melihat ringkasan & dapat mencabut.
 */
export default function SupportGrantPage() {
  const { grantId } = useParams<{ grantId: string }>();
  const me = useMe();
  const [g, setG] = useState<SupportGrant>();
  const [error, setError] = useState<string>();
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api<SupportGrant[]>('/support-access');
      const found = list.find((x) => x.id === grantId);
      if (found) setG(found); else setError('Akses dukungan tidak ditemukan');
    } catch (e) { setError(msg(e, 'Gagal memuat')); }
  }, [grantId]);
  useEffect(() => { void load(); }, [load]);

  async function revoke() {
    setBusy(true);
    try {
      setG(await api<SupportGrant>(`/support-access/${grantId}/revoke`, { method: 'POST' }));
      setRevokeOpen(false);
    } catch (e) { setRevokeOpen(false); setError(msg(e, 'Gagal mencabut akses')); }
    finally { setBusy(false); }
  }

  if (error && !g) return <Alert tone="error">{error}</Alert>;
  if (!g) return <p className="text-sm text-muted-foreground" role="status">Memuat…</p>;
  const owner = g.platformUserId === me.id;
  const canRead = owner && g.active && can(me, 'platform.support.access');
  const canRevoke = g.active && ((owner && can(me, 'platform.support.access')) || can(me, 'platform.tenant.manage'));

  return (
    <div className="grid gap-4">
      <Link href="/support" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />Semua akses dukungan
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Akses dukungan · <Link href={`/tenants/${g.tenantId}`} className="font-mono hover:text-primary">{g.tenantCode}</Link></h1>
        <span data-testid="grant-status"><GrantBadge g={g} /></span>
        {canRevoke ? <Button variant="destructive" size="sm" className="ml-auto" onClick={() => setRevokeOpen(true)}>Cabut akses</Button> : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Support</dt><dd>{g.supportName}</dd>
            <dt className="text-muted-foreground">Alasan</dt><dd>{g.reason}</dd>
            <dt className="text-muted-foreground">Berlaku</dt><dd>{fmtDateTime(g.startsAt)} s.d. {fmtDateTime(g.expiresAt)}</dd>
            {g.revokedAt ? <><dt className="text-muted-foreground">Dicabut</dt><dd>{fmtDateTime(g.revokedAt)}</dd></> : null}
          </dl>
        </CardContent>
      </Card>
      {canRead ? <>
        <Alert tone="info">Data pasien &amp; rekam medis tidak dapat dibuka. Setiap tampilan di bawah tercatat di log audit klinik.</Alert>
        <UsersCard grantId={g.id} onExpired={load} />
        <AuditCard grantId={g.id} onExpired={load} />
      </> : g.active && !owner ? (
        <p className="text-sm text-muted-foreground">Hanya support pemilik akses ini yang dapat membaca data tenant.</p>
      ) : !g.active ? <p className="text-sm text-muted-foreground">Akses sudah berakhir — data tenant tidak dapat dibaca lagi.</p> : null}

      <Dialog open={revokeOpen} onClose={() => setRevokeOpen(false)} title="Cabut akses dukungan?" description={g.tenantCode}>
        <p className="text-sm">Akses langsung berakhir dan admin klinik menerima email bahwa akses telah ditutup.</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setRevokeOpen(false)}>Batal</Button>
          <Button variant="destructive" loading={busy} onClick={revoke}>Ya, cabut</Button>
        </div>
      </Dialog>
    </div>
  );
}

function UsersCard({ grantId, onExpired }: { grantId: string; onExpired: () => void }) {
  const [users, setUsers] = useState<SupportUser[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api<SupportUser[]>(`/support-access/${grantId}/users`).then(setUsers).catch((e) => {
      setError(msg(e, 'Gagal memuat user'));
      if (e instanceof ApiError && e.code === 'PLT-403-GRANT') onExpired();
    });
  }, [grantId, onExpired]);
  return (
    <Card>
      <CardHeader><CardTitle>User &amp; role klinik</CardTitle></CardHeader>
      <CardContent>
        {error ? <Alert tone="error">{error}</Alert> : !users ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : (
          <Table>
            <THead><TR><TH>Nama</TH><TH>Email</TH><TH>Role</TH><TH>Status</TH><TH>Login terakhir</TH></TR></THead>
            <TBody>
              {users.map((u) => (
                <TR key={u.id} data-testid="support-user-row">
                  <TD>{u.fullName}</TD><TD>{u.email}</TD><TD>{u.roles.join(', ') || '—'}</TD>
                  <TD><Badge tone={u.status === 'ACTIVE' ? 'success' : 'neutral'}>{u.status === 'ACTIVE' ? 'Aktif' : 'Nonaktif'}</Badge></TD>
                  <TD className="whitespace-nowrap text-xs">{fmtDateTime(u.lastLoginAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function AuditCard({ grantId, onExpired }: { grantId: string; onExpired: () => void }) {
  const [rows, setRows] = useState<SupportAuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const more = useCallback(async (c?: string | null) => {
    setBusy(true);
    try {
      const p = await api<Page<SupportAuditEntry>>(`/support-access/${grantId}/audit-log?limit=50${c ? `&cursor=${c}` : ''}`);
      setRows((r) => (c ? [...r, ...p.data] : p.data));
      setCursor(p.page.nextCursor);
    } catch (e) {
      setError(msg(e, 'Gagal memuat log audit'));
      if (e instanceof ApiError && e.code === 'PLT-403-GRANT') onExpired();
    } finally { setBusy(false); }
  }, [grantId, onExpired]);
  useEffect(() => { void more(); }, [more]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Log audit klinik</CardTitle>
        <CardDescription>Terbaru dulu. Tanpa identitas pasien dan alamat IP.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Table>
          <THead><TR><TH>#</TH><TH>Waktu</TH><TH>Aktor</TH><TH>Aksi</TH><TH>Objek</TH></TR></THead>
          <TBody>
            {rows.map((a) => (
              <TR key={a.seq} data-testid="support-audit-row">
                <TD className="font-mono text-xs">{a.seq}</TD>
                <TD className="whitespace-nowrap text-xs">{fmtDateTime(a.occurredAt)}</TD>
                <TD className="text-xs">{ACTOR_KIND_LABEL[a.actorKind] ?? a.actorKind}</TD>
                <TD className="font-mono text-xs">{a.action}</TD>
                <TD className="font-mono text-xs">{a.resourceType}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {cursor ? <Button variant="outline" size="sm" loading={busy} onClick={() => more(cursor)} className="justify-self-start">Muat lebih lama</Button> : null}
      </CardContent>
    </Card>
  );
}
