'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, Field, Input, Switch } from '@clinicrme/ui';
import { ApiError, Permission, Role, api, errorText } from '../../../../lib/api';
import { can, useSession } from '../../../../lib/session';

const CODE = /^[A-Z][A-Z0-9_]{2,39}$/;

/**
 * Role & izin (IAM-FR-007/008/005, OD-080). Role bawaan: izin tetap, MFA dapat diatur (kecuali Admin Klinik & Manajer).
 * Role custom: nama, izin, MFA. Perubahan berlaku pada request berikutnya untuk semua pengguna role tersebut.
 */
export default function RolesPage() {
  const s = useSession();
  const manage = can(s, 'iam.role.manage');
  const [roles, setRoles] = useState<Role[]>();
  const [perms, setPerms] = useState<Permission[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [edit, setEdit] = useState<Role | 'new'>();

  const load = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([api<Role[]>('/roles'), api<Permission[]>('/permissions')]);
      setRoles(r); setPerms(p);
    } catch (e) { setError(errorText(e, 'Gagal memuat role')); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggleMfa(r: Role, on: boolean) {
    setError(undefined); setNotice(undefined);
    try {
      await api(`/roles/${r.id}`, { method: 'PUT', headers: { 'if-match': `"${r.version}"` }, body: { requiresMfa: on } });
      setNotice(`MFA untuk ${r.name} ${on ? 'diwajibkan' : 'tidak diwajibkan lagi'}.`);
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'GEN-412-VERSION' ? 'Role sudah diubah orang lain — daftar dimuat ulang.' : errorText(e, 'Gagal mengubah MFA'));
    }
    await load();
  }

  if (error && !roles) return <Alert tone="error">{error}</Alert>;
  if (!roles) return <p className="text-sm text-muted-foreground" role="status">Memuat…</p>;
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Role &amp; izin</h1>
        {manage ? <Button className="ml-auto" onClick={() => setEdit('new')}>Role baru</Button> : null}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {roles.map((r) => (
          <Card key={r.id} data-testid="role-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {r.name} {r.isTemplate ? <Badge tone="neutral">Bawaan</Badge> : <Badge tone="info">Custom</Badge>}
              </CardTitle>
              <CardDescription><span className="font-mono">{r.code}</span> · {r.userCount} pengguna · {r.permissions.length} izin</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <label htmlFor={`mfa-${r.code}`} className="flex items-center justify-between gap-3 text-sm">
                <span>Wajib MFA {r.mfaLocked ? <span className="text-xs text-muted-foreground">(selalu wajib)</span> : null}</span>
                <Switch id={`mfa-${r.code}`} checked={r.requiresMfa} disabled={!manage || r.mfaLocked}
                        onChange={(e) => toggleMfa(r, e.target.checked)} />
              </label>
              {manage && !r.isTemplate ? <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setEdit(r)}>Ubah izin</Button> : null}
            </CardContent>
          </Card>
        ))}
      </div>
      {manage ? <RoleDialog role={edit} perms={perms} onClose={() => setEdit(undefined)}
                            onDone={(msg) => { setEdit(undefined); setNotice(msg); void load(); }} /> : null}
    </div>
  );
}

function RoleDialog({ role, perms, onClose, onDone }: { role?: Role | 'new'; perms: Permission[]; onClose: () => void; onDone: (msg: string) => void }) {
  const isNew = role === 'new';
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [mfa, setMfa] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!role) return;
    setError(undefined);
    if (role === 'new') { setCode(''); setName(''); setMfa(false); setPicked(new Set()); }
    else { setCode(role.code); setName(role.name); setMfa(role.requiresMfa); setPicked(new Set(role.permissions)); }
  }, [role]);
  const modules = useMemo(() => [...new Set(perms.map((p) => p.module))], [perms]);
  const ok = name.trim().length >= 2 && (!isNew || CODE.test(code));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok || !role) return;
    setBusy(true); setError(undefined);
    try {
      if (role === 'new') {
        await api('/roles', { method: 'POST', body: { code, name: name.trim(), requiresMfa: mfa, permissions: [...picked] } });
        onDone(`Role ${name.trim()} dibuat.`);
      } else {
        await api(`/roles/${role.id}`, { method: 'PUT', headers: { 'if-match': `"${role.version}"` }, body: { name: name.trim(), requiresMfa: mfa, permissions: [...picked] } });
        onDone(`Role ${name.trim()} disimpan. Berlaku untuk ${role.userCount} pengguna pada aksi berikutnya.`);
      }
    } catch (err) { setError(errorText(err, 'Gagal menyimpan role')); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={!!role} onClose={onClose} title={isNew ? 'Role baru' : `Ubah role ${typeof role === 'object' ? role.name : ''}`}
            description="Izin administratif (pengguna, role, data & profil klinik, audit) hanya dapat diberikan bila Anda memilikinya."
            className="max-w-2xl">
      <form className="grid gap-3" onSubmit={submit} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="grid gap-3 md:grid-cols-2">
          <Field id="role-code" label="Kode" hint="Huruf besar, angka, garis bawah (mis. PERAWAT_IGD)"
                 error={isNew && code && !CODE.test(code) ? 'Format kode tidak valid' : undefined}>
            <Input id="role-code" value={code} disabled={!isNew} maxLength={40} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </Field>
          <Field id="role-name" label="Nama"><Input id="role-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field>
        </div>
        <label htmlFor="role-mfa" className="flex items-center gap-3 text-sm">
          <Switch id="role-mfa" checked={mfa} onChange={(e) => setMfa(e.target.checked)} /> Wajib MFA
        </label>
        <div className="grid max-h-80 gap-3 overflow-y-auto rounded-md border p-3" data-testid="permission-list">
          {modules.map((m) => (
            <fieldset key={m} className="grid gap-1">
              <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{m}</legend>
              {perms.filter((p) => p.module === m).map((p) => (
                <label key={p.code} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={picked.has(p.code)} aria-label={p.code}
                         onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(p.code); else n.delete(p.code); return n; })} />
                  <span><span className="font-mono">{p.code}</span></span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Batal</Button>
          <Button type="submit" loading={busy} disabled={!ok}>Simpan</Button>
        </div>
      </form>
    </Dialog>
  );
}
