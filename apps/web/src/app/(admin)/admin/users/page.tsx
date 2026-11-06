'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, Field, Input, Select, TBody, TD, TH, THead, TR, Table, Textarea,
} from '@clinicrme/ui';
import { InvitationItem, Page, Practitioner, Role, UserItem, api, errorText } from '../../../../lib/api';
import { PRACTITIONER_TYPE_LABEL, fmtDateTime } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pengguna klinik (IAM-FR-001, 013, 014): daftar, undangan aktif, undang, nonaktif/aktifkan, cabut sesi. */
export default function UsersPage() {
  const s = useSession();
  const manage = can(s, 'iam.user.manage');
  const [users, setUsers] = useState<UserItem[]>();
  const [invites, setInvites] = useState<InvitationItem[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [practitioners, setPractitioners] = useState<Practitioner[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [disable, setDisable] = useState<UserItem>();
  const [resetMfa, setResetMfa] = useState<UserItem>();
  const [link, setLink] = useState<UserItem>();
  const [allPractitioners, setAllPractitioners] = useState<Practitioner[]>([]);

  const load = useCallback(async () => {
    try {
      const [u, i] = await Promise.all([api<Page<UserItem>>('/users?limit=200'), api<InvitationItem[]>('/users/invitations')]);
      setUsers(u.data); setInvites(i);
      if (manage && can(s, 'iam.role.read')) setRoles(await api<Role[]>('/roles'));
      // IAM-FR-016: tenaga kesehatan aktif yang belum punya akun dapat ditautkan saat mengundang
      if (manage && can(s, 'master.practitioner.read')) {
        const [unlinked, all] = await Promise.all([api<Page<Practitioner>>('/practitioners?unlinked=true&limit=200'), api<Page<Practitioner>>('/practitioners?limit=200')]);
        setPractitioners(unlinked.data); setAllPractitioners(all.data);
      }
    } catch (e) { setError(errorText(e, 'Gagal memuat pengguna')); }
  }, [manage, s]);
  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>, msg: string) {
    setError(undefined); setNotice(undefined);
    try { await fn(); setNotice(msg); await load(); } catch (e) { setError(errorText(e, 'Aksi gagal')); }
  }

  if (error && !users) return <Alert tone="error">{error}</Alert>;
  if (!users) return <p className="text-sm text-muted-foreground" role="status">Memuat…</p>;
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Pengguna</h1>
        {manage ? <Button className="ml-auto" onClick={() => setInviteOpen(true)}>Undang pengguna</Button> : null}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          <Table>
            <THead><TR><TH>Nama</TH><TH>Email</TH><TH>Role</TH><TH>Status</TH><TH>Login terakhir</TH>{manage ? <TH className="text-right">Aksi</TH> : null}</TR></THead>
            <TBody>
              {users.map((u) => (
                <TR key={u.id} data-testid="user-row">
                  <TD>{u.fullName}</TD>
                  <TD>{u.email}</TD>
                  <TD className="text-xs">{u.roles.join(', ') || '—'}</TD>
                  <TD>
                    <Badge tone={u.status === 'ACTIVE' ? 'success' : 'neutral'}>{u.status === 'ACTIVE' ? 'Aktif' : 'Nonaktif'}</Badge>
                    {u.mfaEnrolled ? <span className="ml-1 text-xs text-muted-foreground">· MFA</span> : null}
                  </TD>
                  <TD className="whitespace-nowrap text-xs">{fmtDateTime(u.lastLoginAt)}</TD>
                  {manage ? (
                    <TD className="text-right">
                      {u.id === s.me.user.id ? <span className="text-xs text-muted-foreground">Anda</span> : (
                        <span className="inline-flex gap-2">
                          {can(s, 'master.practitioner.read') ? <Button size="sm" variant="outline" onClick={() => setLink(u)}>Tenaga kesehatan</Button> : null}
                          <Button size="sm" variant="outline" onClick={() => act(() => api(`/users/${u.id}/sessions`, { method: 'DELETE' }), `Semua sesi ${u.email} dicabut.`)}>Cabut sesi</Button>
                          {u.mfaEnrolled ? <Button size="sm" variant="outline" onClick={() => setResetMfa(u)}>Reset MFA</Button> : null}
                          {u.status === 'ACTIVE'
                            ? <Button size="sm" variant="destructive" onClick={() => setDisable(u)}>Nonaktifkan</Button>
                            : <Button size="sm" variant="outline" onClick={() => act(() => api(`/users/${u.id}/enable`, { method: 'POST' }), `${u.email} diaktifkan kembali.`)}>Aktifkan</Button>}
                        </span>
                      )}
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Undangan aktif</CardTitle>
          <CardDescription>Belum diterima. Penerima masuk lewat tautan di email (Google atau buat password); berlaku 7 hari.</CardDescription>
        </CardHeader>
        <CardContent>
          {invites.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada undangan aktif.</p> : (
            <ul className="divide-y rounded-md border text-sm">
              {invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" data-testid="invite-row">
                  <span>{i.email} <span className="text-xs text-muted-foreground">· {i.roles?.join(', ')}</span></span>
                  <span className="text-xs text-muted-foreground">berlaku sampai {fmtDateTime(i.expiresAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {manage ? <InviteDialog open={inviteOpen} roles={roles} practitioners={practitioners} onClose={() => setInviteOpen(false)}
                             onDone={(email) => { setInviteOpen(false); void act(async () => undefined, `Undangan dikirim ke ${email}.`); }} /> : null}
      <Dialog open={!!resetMfa} onClose={() => setResetMfa(undefined)} title="Reset MFA?" description={resetMfa?.email ?? ''}>
        <p className="text-sm">Authenticator & recovery code pengguna ini dihapus dan semua sesinya dicabut. Ia harus mendaftarkan
          authenticator baru saat login berikutnya. Lakukan hanya setelah memastikan identitasnya (mis. bertemu langsung).</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setResetMfa(undefined)}>Batal</Button>
          <Button variant="destructive" onClick={() => { const u = resetMfa!; setResetMfa(undefined);
            void act(() => api(`/users/${u.id}/mfa`, { method: 'DELETE' }), `MFA ${u.email} direset; ia akan diminta mendaftar ulang.`); }}>Ya, reset MFA</Button>
        </div>
      </Dialog>
      {link ? <LinkDialog user={link} options={allPractitioners.filter((p) => p.id === link.practitionerId || practitioners.some((x) => x.id === p.id))}
                          current={allPractitioners.find((p) => p.id === link.practitionerId)} onClose={() => setLink(undefined)}
                          onSave={(pid) => { const u = link; setLink(undefined);
                            void act(() => api(`/users/${u.id}/practitioner`, { method: 'POST', body: { practitionerId: pid } }),
                              pid ? `${u.email} ditautkan ke tenaga kesehatan.` : `Tautan tenaga kesehatan ${u.email} dilepas.`); }} /> : null}
      <DisableDialog user={disable} onClose={() => setDisable(undefined)}
                     onDone={(u) => { setDisable(undefined); void act(async () => undefined, `${u.email} dinonaktifkan; semua sesinya dicabut.`); }} />
    </div>
  );
}

function InviteDialog({ open, roles, practitioners, onClose, onDone }: {
  open: boolean; roles: Role[]; practitioners: Practitioner[]; onClose: () => void; onDone: (email: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [practitionerId, setPractitionerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { if (open) { setEmail(''); setFullName(''); setPicked([]); setPractitionerId(''); setError(undefined); } }, [open]);
  const ok = EMAIL.test(email.trim()) && picked.length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError(undefined);
    try {
      await api('/users/invitations', { method: 'POST', body: { email: email.trim(), ...(fullName.trim() ? { fullName: fullName.trim() } : {}), roleIds: picked,
        ...(practitionerId ? { practitionerId } : {}) } });
      onDone(email.trim().toLowerCase());
    } catch (err) { setError(errorText(err, 'Gagal mengundang')); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Undang pengguna" description="Email undangan berisi tautan untuk masuk dengan Google atau membuat password.">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="inv-email" label="Email"><Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field id="inv-name" label="Nama (opsional)"><Input id="inv-name" value={fullName} maxLength={200} onChange={(e) => setFullName(e.target.value)} /></Field>
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-sm font-medium">Role</legend>
          {roles.map((r) => (
            <label key={r.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={picked.includes(r.id)}
                     onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))} />
              {r.name}{r.requiresMfa ? <span className="text-xs text-muted-foreground">(wajib MFA)</span> : null}
            </label>
          ))}
        </fieldset>
        {practitioners.length ? (
          <Field id="inv-practitioner" label="Tenaga kesehatan (opsional)" hint="Untuk dokter/nakes: menautkan akun ke data STR/SIP (dasar tanda tangan klinis).">
            <Select id="inv-practitioner" value={practitionerId} onChange={(e) => {
              setPractitionerId(e.target.value);
              const p = practitioners.find((x) => x.id === e.target.value);
              if (p && !fullName.trim()) setFullName(p.fullName);
            }}>
              <option value="">— tidak ditautkan —</option>
              {practitioners.map((p) => <option key={p.id} value={p.id}>{p.fullName} · {PRACTITIONER_TYPE_LABEL[p.practitionerType]}</option>)}
            </Select>
          </Field>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!ok}>Kirim undangan</Button>
        </div>
      </form>
    </Dialog>
  );
}

function DisableDialog({ user, onClose, onDone }: { user?: UserItem; onClose: () => void; onDone: (u: UserItem) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { setReason(''); setError(undefined); }, [user]);
  async function submit() {
    if (!user) return;
    setBusy(true); setError(undefined);
    try { await api(`/users/${user.id}/disable`, { method: 'POST', body: { reason: reason.trim() } }); onDone(user); }
    catch (e) { setError(errorText(e, 'Gagal menonaktifkan')); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={!!user} onClose={onClose} title="Nonaktifkan pengguna?" description={user?.email ?? ''}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <p className="text-sm">Pengguna tidak dapat masuk dan semua sesinya langsung dicabut. Data & riwayatnya tetap tersimpan.</p>
      <Field id="disable-reason" label="Alasan"><Textarea id="disable-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Batal</Button>
        <Button variant="destructive" loading={busy} disabled={reason.trim().length < 3} onClick={submit}>Ya, nonaktifkan</Button>
      </div>
    </Dialog>
  );
}

/**
 * IAM-FR-016: menautkan akun yang sudah ada ke data tenaga kesehatan (STR/SIP). Dibutuhkan dokter untuk mengesahkan
 * rekam medis dan untuk filter "pasien saya". Satu tenaga kesehatan hanya untuk satu akun.
 */
function LinkDialog({ user, options, current, onClose, onSave }: {
  user: UserItem; options: Practitioner[]; current?: Practitioner; onClose: () => void; onSave: (practitionerId: string | null) => void;
}) {
  const [pid, setPid] = useState(user.practitionerId ?? '');
  return (
    <Dialog open onClose={onClose} title="Tautkan tenaga kesehatan" description={user.email}>
      <div className="grid gap-3">
        <p className="text-sm">Saat ini: <b>{current ? current.fullName : 'belum ditautkan'}</b></p>
        <Field id="link-practitioner" label="Tenaga kesehatan">
          <Select id="link-practitioner" value={pid} onChange={(e) => setPid(e.target.value)}>
            <option value="">— tidak ditautkan —</option>
            {options.map((p) => <option key={p.id} value={p.id}>{p.fullName} · {PRACTITIONER_TYPE_LABEL[p.practitionerType]}</option>)}
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Batal</Button>
          <Button disabled={pid === (user.practitionerId ?? '')} onClick={() => onSave(pid || null)}>Simpan</Button>
        </div>
      </div>
    </Dialog>
  );
}

